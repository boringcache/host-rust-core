import { expect, test } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import {
  createClient,
  createMessagePortProvider,
  createTransport,
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedRemotePermissionResponse,
  VersionedRemotePermissionError,
  type ProtocolMessage,
} from '@parity/truapi';
import { PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION } from '@parity/truapi/wire-table';

const build = await Bun.build({
  entrypoints: [new URL('./network-transport.ts', import.meta.url).pathname],
  target: 'browser',
  format: 'cjs',
});
if (!build.success) throw new Error(build.logs.join('\n'));
const source = await build.outputs[0].text();
const permission = { permission: { tag: 'Remote' as const, value: { domains: ['api.example'] } } };

function fixture(respond = true) {
  const requests: ProtocolMessage[] = [];
  const replies: ProtocolMessage[] = [];
  let connections = 0;
  let grant = false;
  let changed = () => {};
  let closeSocket = () => {};
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        connections++;
        closeSocket = () => socket.close();
      },
      message(socket, data) {
        const request = decodeWireMessage(new Uint8Array(data as Buffer))._unsafeUnwrap();
        requests.push(request);
        changed();
        if (!respond) return;
        const consume = request.payload.methodId === PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION.method;
        const granted = consume ? grant : true;
        grant = !consume;
        socket.send(
          encodeWireMessage({
            ...request,
            payload: {
              ...request.payload,
              messageType: MESSAGE_TYPE_RESPONSE,
              value: scale
                .Result(
                  VersionedRemotePermissionResponse,
                  scale.CallError(VersionedRemotePermissionError),
                )
                .enc({ success: true, value: { tag: 'V1', value: { granted } } }),
            },
          })._unsafeUnwrap(),
        );
      },
    },
  });
  const channel = new MessageChannel();
  channel.port1.addEventListener('message', ({ data }) => {
    replies.push(decodeWireMessage(data)._unsafeUnwrap());
  });
  const events = new EventTarget();
  const context = createContext({
    module: { exports: {} },
    MessageChannel,
    MessagePort,
    MessageEvent,
    Event,
    EventTarget,
    WebSocket,
    TextEncoder,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    __truapi_localhost: { url: server.url.href.replace('http:', 'ws:') },
    __HOST_API_PORT__: channel.port1,
  });
  runInContext(source, context);
  const createAuthorization = runInContext('module.exports.createPermissionAuthorization', context);
  const authorize = createAuthorization(runInContext('globalThis', context), channel).network as (
    url: string,
    decide: (allowed: boolean) => void,
  ) => () => void;
  const provider = createMessagePortProvider(channel.port1);
  const client = createClient(createTransport(provider));
  return {
    context,
    requests,
    replies,
    channel,
    client,
    get connections() {
      return connections;
    },
    authorize: () => new Promise<boolean>((resolve) => authorize('https://api.example/', resolve)),
    closeSocket: () => closeSocket(),
    async received(count: number) {
      while (requests.length < count)
        await new Promise<void>((resolve) => {
          changed = resolve;
        });
    },
    stop() {
      events.dispatchEvent(new Event('pagehide'));
      provider.dispose();
      channel.port1.close();
      channel.port2.close();
      server.stop(true);
    },
  };
}

async function bounded<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('host channel did not settle')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

test('early SDK calls and private authorization share one socket without exposing private replies', async () => {
  const host = fixture();
  try {
    const grant = host.client.permissions.requestRemotePermission(permission);
    expect(host.requests).toEqual([]);
    expect((await bounded(grant))._unsafeUnwrap()).toEqual({ granted: true });
    expect(await bounded(host.authorize())).toBe(true);
    runInContext(
      `
      const iterate = Set.prototype[Symbol.iterator];
      Set.prototype[Symbol.iterator] = function* () {
        for (const item of iterate.call(this)) {
          if (typeof item === 'function') yield bytes => {
            if (bytes instanceof Uint8Array && bytes.length > 10) bytes[bytes.length - 1] = 1;
            return item(bytes);
          };
          else yield item;
        }
      };
      Uint8Array.prototype.subarray = () => new Uint8Array();
    `,
      host.context,
    );
    expect(await bounded(host.authorize())).toBe(false);
    expect({
      connections: host.connections,
      publicReplies: host.replies.map((reply) => reply.requestId),
      privateRequests: host.requests.slice(1).map((request) => request.requestId.startsWith('~')),
    }).toEqual({
      connections: 1,
      publicReplies: [host.requests[0]!.requestId],
      privateRequests: [true, true],
    });
  } finally {
    host.stop();
  }
});

test('reserved public IDs and socket closure fail pending SDK and private calls', async () => {
  for (const reason of ['reserved', 'noncanonical', 'shared', 'socket'] as const) {
    const host = fixture(false);
    try {
      const sdk = Promise.resolve(host.client.permissions.requestRemotePermission(permission)).then(
        (result) => result.isErr(),
        () => true,
      );
      const privateCall = host.authorize();
      await bounded(host.received(2));
      if (reason === 'socket') host.closeSocket();
      else {
        const frame = encodeWireMessage({
          ...host.requests[0]!,
          requestId: reason === 'shared' ? 'public-shared' : '~forged',
        })._unsafeUnwrap();
        let invalid =
          reason === 'noncanonical'
            ? new Uint8Array([frame[0]! | 1, 0, ...frame.subarray(1)])
            : frame;
        if (reason === 'shared') {
          invalid = new Uint8Array(new SharedArrayBuffer(frame.length));
          invalid.set(frame);
        }
        host.channel.port1.postMessage(invalid);
      }
      expect({
        sdkFailed: await bounded(sdk),
        privateDecision: await bounded(privateCall),
        requests: host.requests.length,
        replies: host.replies.length,
      }).toEqual({ sdkFailed: true, privateDecision: false, requests: 2, replies: 0 });
    } finally {
      host.stop();
    }
  }
});
