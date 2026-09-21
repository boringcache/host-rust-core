import { describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
  createMessagePortProvider,
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedRemotePermissionError,
  VersionedRemotePermissionResponse,
} from "@parity/truapi";
import { createPermissionAuthorization } from "../../../../js/container/src/network-transport.ts";

const bundle = await Bun.build({
  entrypoints: [new URL("./sandbox-bridge.ts", import.meta.url).pathname],
  target: "browser",
  format: "iife",
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const bootstrap = await bundle.outputs[0].text();

function frame(requestId: string) {
  return encodeWireMessage({
    requestId,
    payload: {
      traitId: 1,
      methodId: 2,
      messageType: 0,
      value: new Uint8Array([3]),
    },
  })._unsafeUnwrap();
}

function browser() {
  const sent: Uint8Array[] = [];
  const sockets: Socket[] = [];
  let changed = () => {};
  class Socket extends EventTarget {
    closed = false;
    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
    send(bytes: Uint8Array) {
      sent.push(bytes);
      changed();
    }
  }
  const failures: unknown[] = [];
  const runtime = Object.assign(new EventTarget(), {
    __truapi_cli_frame_url__: "ws://127.0.0.1:9955/frames" as
      | string
      | undefined,
    WebSocket: Socket,
    Event,
    EventTarget,
    MessageChannel,
    MessagePort,
    MessageEvent,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    console: { error: (...values: unknown[]) => failures.push(values) },
    __HOST_API_PORT__: undefined as MessagePort | undefined,
    __truapi_network_port__: undefined as
      | {
          postMessage(bytes: Uint8Array): void;
          onmessage: ((event: { data: Uint8Array }) => void) | null;
          onmessageerror: (() => void) | null;
        }
      | undefined,
  });
  const context = createContext({ ...runtime, window: runtime });
  runInContext(bootstrap, context);
  const socket = sockets[0]!;
  const port = runtime.__HOST_API_PORT__!;
  port.start();
  return {
    runtime,
    context,
    sent,
    sockets,
    socket,
    port,
    failures,
    privatePort: runtime.__truapi_network_port__!,
    open: () => socket.dispatchEvent(new Event("open")),
    reply: (bytes: Uint8Array) =>
      socket.dispatchEvent(new MessageEvent("message", { data: bytes.buffer })),
    async frames(count: number) {
      while (sent.length < count)
        await new Promise<void>((resolve) => {
          changed = resolve;
        });
      return sent.map(
        (bytes) => decodeWireMessage(bytes)._unsafeUnwrap().requestId,
      );
    },
    stop: () => runtime.dispatchEvent(new Event("pagehide")),
  };
}

function publicReply(port: MessagePort): Promise<Uint8Array> {
  return new Promise((resolve) =>
    port.addEventListener("message", (event) => resolve(event.data), {
      once: true,
    }),
  );
}

describe("one Rust execution for public calls and private authorization", () => {
  it("queues both channels on one native socket and keeps colliding replies private", async () => {
    const bridge = browser();
    try {
      const privateReplies: Uint8Array[] = [];
      bridge.privatePort.onmessage = ({ data }) => privateReplies.push(data);
      bridge.port.postMessage(frame("grant"));
      bridge.privatePort.postMessage(frame("grant"));
      expect(bridge.sent).toEqual([]);
      bridge.open();
      expect((await bridge.frames(2)).sort()).toEqual(["grant", "~grant"]);
      const publicResult = publicReply(bridge.port);
      bridge.reply(frame("~grant"));
      bridge.reply(frame("grant"));
      const publicFrame = await publicResult;
      const subscription = publicReply(bridge.port);
      bridge.reply(frame("host:subscription"));
      expect({
        privateReplies,
        publicFrame,
        subscription: await subscription,
        sockets: bridge.sockets.length,
        endpoint: bridge.runtime.__truapi_cli_frame_url__,
      }).toEqual({
        privateReplies: [frame("grant")],
        publicFrame: frame("grant"),
        subscription: frame("host:subscription"),
        sockets: 1,
        endpoint: undefined,
      });
    } finally {
      bridge.stop();
    }
  });

  it("preserves SCALE request IDs across compact-length boundaries", async () => {
    const bridge = browser();
    try {
      bridge.open();
      const replies: Uint8Array[] = [];
      bridge.privatePort.onmessage = ({ data }) => replies.push(data);
      const originals = [0, 16, 63, 64, 16383, 16384].map((length) =>
        frame("a".repeat(length)),
      );
      for (const bytes of originals) bridge.privatePort.postMessage(bytes);
      for (const bytes of bridge.sent) bridge.reply(bytes);
      expect(replies).toEqual(originals);
    } finally {
      bridge.stop();
    }
  });

  it.each([
    frame("~grant"),
    new Uint8Array(),
    new Uint16Array([4, 97, 1, 2, 0, 3]),
  ])(
    "closes the connection on a forged private ID or malformed public frame",
    async (bytes) => {
      const bridge = browser();
      try {
        bridge.open();
        const failed = new Promise<void>((resolve) => {
          bridge.privatePort.onmessageerror = resolve;
        });
        bridge.port.postMessage(bytes);
        await failed;
        bridge.reply(frame("late"));
        expect({
          frames: bridge.sent,
          closed: bridge.socket.closed,
          failures: bridge.failures.length,
        }).toEqual({ frames: [], closed: true, failures: 1 });
      } finally {
        bridge.stop();
      }
    },
  );

  it("settles pending SDK and permission calls when the frame socket closes", async () => {
    const bridge = browser();
    try {
      const provider = createMessagePortProvider(bridge.port);
      const closed: Error[] = [];
      provider.subscribeClose!((error) => closed.push(error));
      const { network } = createPermissionAuthorization(
        bridge.runtime as unknown as Window & typeof globalThis,
      );
      const decisions: boolean[] = [];
      network("https://example.com", (allowed) => decisions.push(allowed));
      await Promise.resolve();
      bridge.socket.dispatchEvent(new Event("close"));
      network("https://example.com/later", (allowed) =>
        decisions.push(allowed),
      );
      expect({
        decisions,
        closed,
        failures: bridge.failures.length,
        socketClosed: bridge.socket.closed,
      }).toEqual({
        decisions: [false, false],
        closed: [expect.any(Error)],
        failures: 1,
        socketClosed: true,
      });
    } finally {
      bridge.stop();
    }
  });

  it("cannot turn Rust denial into approval by replacing collection iteration", async () => {
    const bridge = browser();
    try {
      const { network } = createPermissionAuthorization(
        bridge.runtime as unknown as Window & typeof globalThis,
      );
      const decision = new Promise<boolean>((resolve) =>
        network("https://example.com", resolve),
      );
      bridge.open();
      await bridge.frames(1);
      const request = decodeWireMessage(bridge.sent[0]!)._unsafeUnwrap();
      const response = encodeWireMessage({
        requestId: request.requestId,
        payload: {
          ...request.payload,
          messageType: MESSAGE_TYPE_RESPONSE,
          value: scale
            .Result(
              VersionedRemotePermissionResponse,
              scale.CallError(VersionedRemotePermissionError),
            )
            .enc({
              success: true,
              value: { tag: "V1", value: { granted: false } },
            }),
        },
      })._unsafeUnwrap();
      runInContext(
        `
        const iterate = Set.prototype[Symbol.iterator];
        Set.prototype[Symbol.iterator] = function* () {
          for (const item of iterate.call(this)) {
            if (typeof item === 'function') yield (bytes) => {
              if (bytes instanceof Uint8Array && bytes.length > 10) bytes[bytes.length - 1] = 1;
              return item(bytes);
            };
            else yield item;
          }
        };
      `,
        bridge.context,
      );
      bridge.reply(response);
      expect(await decision).toBe(false);
    } finally {
      bridge.stop();
    }
  });
});
