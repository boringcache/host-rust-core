import { expect, spyOn, test } from "bun:test";
import { chromium } from "playwright-core";
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedRemotePermissionRequest,
  VersionedRemotePermissionResponse,
  VersionedRemotePermissionError,
  type ProtocolMessage,
  type WireProvider,
} from "@parity/truapi";
import { PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION } from "../../../../js/packages/truapi/src/generated/wire-table.ts";
import {
  runBrowserScript,
  type BrowserScriptOptions,
} from "./sandbox-runner.ts";

const cors = { "Access-Control-Allow-Origin": "*" };
const permission =
  "{ permission: { tag: 'Remote', value: { domains: ['127.0.0.1'] } } }";
const privateRequest = (request: ProtocolMessage) =>
  request.payload.methodId === PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION.method;

function reply(request: ProtocolMessage, allowed: boolean): Uint8Array {
  const value = scale
    .Result(
      VersionedRemotePermissionResponse,
      scale.CallError(VersionedRemotePermissionError),
    )
    .enc({ success: true, value: { tag: "V1", value: { granted: allowed } } });
  return encodeWireMessage({
    ...request,
    payload: { ...request.payload, messageType: MESSAGE_TYPE_RESPONSE, value },
  })._unsafeUnwrap();
}

function permissions(
  decide: (
    request: ProtocolMessage,
    send: (request: ProtocolMessage, allowed: boolean) => void,
  ) => void = (request, send) => send(request, false),
) {
  const listeners = new Set<(message: Uint8Array) => void>();
  const requests: ProtocolMessage[] = [];
  let disposals = 0;
  const send = (request: ProtocolMessage, allowed: boolean) => {
    for (const listener of listeners) listener(reply(request, allowed));
  };
  const provider: WireProvider = {
    postMessage(frame) {
      const request = decodeWireMessage(frame)._unsafeUnwrap();
      requests.push(request);
      decide(request, send);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposals++;
      listeners.clear();
    },
  };
  return {
    provider,
    requests,
    get disposals() {
      return disposals;
    },
  };
}

function run(
  source: string,
  fixture = permissions(),
  options: Partial<BrowserScriptOptions> = {},
) {
  return runBrowserScript({
    source,
    productId: "sandbox.testnet",
    provider: fixture.provider,
    timeoutMs: 10_000,
    ...options,
  });
}

function requestScript(api: "fetch" | "XHR"): string {
  if (api === "fetch") return "const request = fetch;";
  return `function request(url, options = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      XMLHttpRequest.prototype.open.call(xhr, options.method ?? 'GET', url);
      xhr.onload = () => resolve({ text: async () => xhr.responseText });
      xhr.onerror = () => reject(new TypeError('XHR failed'));
      xhr.onabort = () => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value);
      options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      XMLHttpRequest.prototype.send.call(xhr, options.body ?? null);
    });
  }`;
}

function httpEndpoint() {
  const hits: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return new Response("authorized", { headers: cors });
    },
  });
  return { server, hits, url: JSON.stringify(server.url.href) };
}

test("the first product statement sees the shipped sandbox and CLI helpers", async () => {
  const messages: string[] = [];
  await run(
    `
    assert(globalThis.__HOST_WEBVIEW_MARK__ === true);
    assert(globalThis.__truapi_network_port__ === undefined);
    assert(globalThis.__truapi_cli_frame_url__ === undefined);
    assert(host.productId === 'sandbox.testnet');
    assert(host.productAccount(2).derivationIndex.value === 2);
    for (const name of ['process', 'Bun', 'require', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection'])
      assert(typeof globalThis[name] === 'undefined', name + ' must be unavailable');
    assert(eval('1') === 1);
    export default async context => console.log('completed ' + context.productId);
  `,
    permissions(),
    { onConsole: (_, message) => messages.push(message) },
  );
  expect(messages).toContain("completed sandbox.testnet");
}, 20_000);

for (const api of ["fetch", "XHR"] as const) {
  test(`public Allow once authorizes exactly one native ${api} in the same execution`, async () => {
    const endpoint = httpEndpoint();
    let grant = false;
    const fixture = permissions((request, send) => {
      if (privateRequest(request)) {
        send(request, grant);
        grant = false;
      } else {
        grant = true;
        send(request, true);
      }
    });
    try {
      await run(
        `
        ${requestScript(api)}
        assert((await truapi.permissions.requestRemotePermission(${permission}))._unsafeUnwrap().granted);
        assert(await (await request(${endpoint.url})).text() === 'authorized');
        try { await request(${endpoint.url}); throw new Error('grant reused'); }
        catch (error) { assert(error instanceof TypeError); }
      `,
        fixture,
      );
      expect({
        hits: endpoint.hits,
        privateRequests: fixture.requests
          .filter(privateRequest)
          .map((request) =>
            VersionedRemotePermissionRequest.dec(request.payload.value),
          ),
        publicRequests: fixture.requests.filter(
          (request) => !privateRequest(request),
        ).length,
      }).toEqual({
        hits: ["/"],
        privateRequests: Array(2).fill({
          tag: "V1",
          value: {
            permission: { tag: "Remote", value: { domains: ["127.0.0.1"] } },
          },
        }),
        publicRequests: 1,
      });
    } finally {
      endpoint.server.stop(true);
    }
  }, 20_000);
}

for (const outcome of ["completion", "rejection", "timeout"] as const) {
  test(`${outcome} closes native sockets and disposes the provider`, async () => {
    const fixture = permissions((request, send) => send(request, true));
    let notifyClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message() {},
        close() {
          notifyClosed();
        },
      },
    });
    try {
      const execution = run(
        `
        const socket = new WebSocket(${JSON.stringify(endpoint.url.href.replace("http:", "ws:"))});
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        ${outcome === "timeout" ? "await new Promise(() => {});" : outcome === "rejection" ? "throw new Error('product failure');" : ""}
      `,
        fixture,
        { timeoutMs: outcome === "timeout" ? 2_000 : 10_000 },
      );
      if (outcome === "completion") await execution;
      else
        await expect(execution).rejects.toThrow(
          outcome === "timeout"
            ? "Product script timed out"
            : "product failure",
        );
      await Promise.race([
        closed,
        Bun.sleep(1_000).then(() => {
          throw new Error("socket was not closed");
        }),
      ]);
      expect(fixture.disposals).toBe(1);
    } finally {
      endpoint.stop(true);
    }
  }, 20_000);
}

test("browser shutdown retains its connection and preserves product failure", async () => {
  const fixture = permissions();
  let disposalsBeforeBrowserClose: number | undefined;
  const launch = chromium.launch.bind(chromium);
  const mocked = spyOn(chromium, "launch").mockImplementation(
    async (options) => {
      const browser = await launch(options);
      const close = browser.close.bind(browser);
      browser.close = async () => {
        disposalsBeforeBrowserClose = fixture.disposals;
        await close();
        throw new Error("browser cleanup failed");
      };
      return browser;
    },
  );
  try {
    await expect(
      run("throw new Error('product failure');", fixture),
    ).rejects.toThrow("product failure");
    expect({
      disposalsBeforeBrowserClose,
      finalDisposals: fixture.disposals,
    }).toEqual({
      disposalsBeforeBrowserClose: 0,
      finalDisposals: 1,
    });
  } finally {
    mocked.mockRestore();
  }
}, 20_000);

test("a product blocking its renderer cannot prevent timeout and cleanup", async () => {
  const fixture = permissions();
  await expect(
    run("while (true) {}", fixture, { timeoutMs: 250 }),
  ).rejects.toThrow("Product script timed out");
  expect(fixture.disposals).toBe(1);
}, 5_000);
