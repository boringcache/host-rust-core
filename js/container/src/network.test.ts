import { describe, expect, it } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedAuthorizeNetworkAccessRequest,
  VersionedAuthorizeNetworkAccessResponse,
  VersionedAuthorizeNetworkAccessError,
} from '@parity/truapi';
import { PERMISSIONS_AUTHORIZE_NETWORK_ACCESS } from '@parity/truapi/wire-table';

const build = await Bun.build({
  entrypoints: [new URL('./index.ts', import.meta.url).pathname],
  target: 'browser',
  format: 'iife',
});
if (!build.success) throw new Error(build.logs.join('\n'));
const container = await build.outputs[0].text();
const origin = 'https://product.example';

function browser(
  authorize?: (url: string) => boolean | Promise<boolean>,
  pageUrl = `${origin}/index.html`,
  transport: 'port' | 'socket' = 'port',
  transformReply: (bytes: Uint8Array) => Uint8Array = (bytes) => bytes,
) {
  class BrowserRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        input instanceof Request ? input : new URL(String(input), pageUrl),
        init,
      );
    }
  }
  for (const [name, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(Request.prototype),
  )) {
    Object.defineProperty(BrowserRequest.prototype, name, {
      ...descriptor,
      configurable: true,
    });
  }

  const requests: Request[] = [];
  const sent: Uint8Array[] = [];
  const sockets: BrowserSocket[] = [];
  const deadlines: (() => void)[] = [];
  const sdkHandler = () => {};
  const sdkPort = { onmessage: sdkHandler };
  class BrowserEvents extends EventTarget {}
  const NativeMessageEvent: new (
    type: string,
    init?: MessageEventInit,
  ) => MessageEvent = MessageEvent;
  class BrowserMessage extends NativeMessageEvent {}
  class BrowserEncoder extends TextEncoder {}
  for (const [target, source] of [
    [BrowserEvents, EventTarget],
    [BrowserMessage, MessageEvent],
    [BrowserEncoder, TextEncoder],
  ]) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(source!.prototype),
    )) {
      if (name !== 'constructor')
        Object.defineProperty(target!.prototype, name, descriptor);
    }
  }
  const privatePort = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onmessageerror: null as (() => void) | null,
    postMessage(message: Uint8Array) {
      handle(message, (data) =>
        privatePort.onmessage?.({ data } as MessageEvent),
      );
    },
  };
  function handle(message: Uint8Array, deliver: (data: Uint8Array) => void) {
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const buffer = Object.getOwnPropertyDescriptor(
      prototype,
      'buffer',
    )!.get!.call(message);
    const offset = Object.getOwnPropertyDescriptor(
      prototype,
      'byteOffset',
    )!.get!.call(message);
    const length = Object.getOwnPropertyDescriptor(
      prototype,
      'byteLength',
    )!.get!.call(message);
    message = new Uint8Array(buffer, offset, length);
    sent.push(message);
    const decoded = decodeWireMessage(message)._unsafeUnwrap();
    expect({
      trait: decoded.payload.traitId,
      method: decoded.payload.methodId,
      kind: 'request',
    }).toEqual(PERMISSIONS_AUTHORIZE_NETWORK_ACCESS);
    const { url } = VersionedAuthorizeNetworkAccessRequest.dec(
      decoded.payload.value,
    ).value;
    Promise.resolve(authorize!(url)).then(
      (allowed) => {
        const reply = encodeWireMessage({
          requestId: decoded.requestId,
          payload: {
            ...decoded.payload,
            messageType: MESSAGE_TYPE_RESPONSE,
            value: scale
              .Result(
                VersionedAuthorizeNetworkAccessResponse,
                scale.CallError(VersionedAuthorizeNetworkAccessError),
              )
              .enc({ success: true, value: { tag: 'V1', value: { allowed } } }),
          },
        })._unsafeUnwrap();
        deliver(transformReply(reply));
      },
      () => privatePort.onmessageerror?.(),
    );
  }
  class BrowserSocket extends BrowserEvents {
    binaryType = '';
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(frame: Uint8Array) {
      handle(frame, (data) =>
        this.dispatchEvent(
          new BrowserMessage('message', { data: data.buffer }),
        ),
      );
    }
    close() {}
  }
  const context = createContext({
    URL,
    Request: BrowserRequest,
    Response,
    AbortSignal,
    EventTarget: BrowserEvents,
    MessageEvent: BrowserMessage,
    TextEncoder: BrowserEncoder,
    TextDecoder,
    setTimeout(callback: () => void, delay: number) {
      deadlines.push(callback);
      return setTimeout(callback, delay);
    },
    clearTimeout,
    WebSocket: BrowserSocket,
    WebTransport: class {},
    Worker: class {},
    SharedWorker: class {},
    navigator: {},
    document: { createElement: () => ({}) },
    location: { href: pageUrl, origin: new URL(pageUrl).origin },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new BrowserRequest(input, init));
      return new Response('received');
    },
    __HOST_API_PORT__: sdkPort,
    __truapi_network_port__:
      authorize && transport === 'port' ? privatePort : undefined,
    __truapi_localhost:
      authorize && transport === 'socket'
        ? { url: 'ws://127.0.0.1:1234/?t=secret' }
        : undefined,
  });
  runInContext('window = globalThis', context);
  runInContext(container, context);
  return {
    context,
    requests,
    sent,
    sockets,
    sdkPort,
    sdkHandler,
    privatePort,
    deadlines,
    fetch: context.fetch as typeof fetch,
  };
}

describe('container fetch authorization', () => {
  it('sends authorization through a private binary port without replacing the SDK port', async () => {
    const realm = browser(() => true);
    await realm.fetch('https://api.example/data');
    expect({
      sent: realm.sent.length,
      sdkHandler: realm.sdkPort.onmessage,
    }).toEqual({ sent: 1, sdkHandler: realm.sdkHandler });
  });
  it('uses an existing grant immediately for a cross-origin fetch', async () => {
    const authorized: string[] = [];
    const realm = browser(async (url) => {
      authorized.push(url);
      return true;
    });
    const response = await realm.fetch('https://api.example/data');
    expect({
      status: response.status,
      authorized,
      requested: realm.requests.map((request) => request.url),
    }).toEqual({
      status: 200,
      authorized: ['https://api.example/data'],
      requested: ['https://api.example/data'],
    });
  });

  it('uses the authenticated native bridge without the legacy Swift hook', async () => {
    const authorized: string[] = [];
    const realm = browser(
      (url) => {
        authorized.push(url);
        return true;
      },
      undefined,
      'socket',
    );
    await realm.fetch('https://api.example/data');
    expect({
      authorized,
      sockets: realm.sockets.map((socket) => socket.url),
      requests: realm.requests.length,
    }).toEqual({
      authorized: ['https://api.example/data'],
      sockets: ['ws://127.0.0.1:1234/?t=secret'],
      requests: 1,
    });
  });

  it('correlates concurrent replies and rejects stale grants for a different request', async () => {
    const decisions = new Map<string, (allowed: boolean) => void>();
    const realm = browser(
      (url) =>
        new Promise((resolve) => {
          decisions.set(url, resolve);
        }),
    );
    const denied = realm.fetch('https://denied.example/data');
    const granted = realm.fetch('https://allowed.example/data');
    decisions.get('https://allowed.example/data')!(true);
    await granted;
    const stale = decodeWireMessage(realm.sent[1]!)._unsafeUnwrap();
    stale.payload.messageType = MESSAGE_TYPE_RESPONSE;
    stale.payload.value = scale
      .Result(
        VersionedAuthorizeNetworkAccessResponse,
        scale.CallError(VersionedAuthorizeNetworkAccessError),
      )
      .enc({ success: true, value: { tag: 'V1', value: { allowed: true } } });
    realm.privatePort.onmessage!({
      data: encodeWireMessage(stale)._unsafeUnwrap(),
    } as MessageEvent);
    decisions.get('https://denied.example/data')!(false);
    await expect(denied).rejects.toThrow('Network access is not allowed');
    expect(realm.requests.map((request) => request.url)).toEqual([
      'https://allowed.example/data',
    ]);
  });

  for (const corruption of [
    'method',
    'message type',
    'trailing bytes',
    'truncated payload',
  ]) {
    it(`rejects a grant reply with ${corruption}`, async () => {
      const realm = browser(
        () => true,
        undefined,
        'port',
        (frame) => {
          const decoded = decodeWireMessage(frame)._unsafeUnwrap();
          if (corruption === 'method') decoded.payload.methodId++;
          if (corruption === 'message type') decoded.payload.messageType++;
          if (corruption === 'trailing bytes')
            decoded.payload.value = new Uint8Array([
              ...decoded.payload.value,
              0,
            ]);
          if (corruption === 'truncated payload')
            decoded.payload.value = decoded.payload.value.slice(0, -1);
          return encodeWireMessage(decoded)._unsafeUnwrap();
        },
      );
      await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
        'Network access is not allowed',
      );
      expect(realm.requests).toEqual([]);
    });
  }

  it('encodes long URLs and Unicode using the generated protocol schema', async () => {
    const authorized: string[] = [];
    const realm = browser((url) => {
      authorized.push(url);
      return true;
    });
    const urls = [
      'https://api.example/short',
      `https://api.example/\u96ea?value=${'a'.repeat(100)}`,
      `https://api.example/?value=${'b'.repeat(16_400)}`,
    ];
    for (const url of urls) await realm.fetch(url);
    expect(authorized).toEqual(urls.map((url) => new URL(url).href));
  });

  it('denies pending and later fetches when the private transport closes', async () => {
    const realm = browser(() => new Promise(() => {}));
    const pending = realm.fetch('https://api.example/pending');
    realm.privatePort.onmessageerror!();
    await expect(pending).rejects.toThrow('Network access is not allowed');
    await expect(realm.fetch('https://api.example/later')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect({ frames: realm.sent.length, requests: realm.requests }).toEqual({
      frames: 1,
      requests: [],
    });
  });

  it('bounds an unanswered permission request and ignores a late approval', async () => {
    let reply!: (allowed: boolean) => void;
    const realm = browser(
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    const pending = realm.fetch('https://denied.example/data');
    realm.deadlines[0]!();
    await expect(pending).rejects.toThrow('Network access is not allowed');
    reply(true);
    await Promise.resolve();
    expect(realm.requests).toEqual([]);
  });

  it('ignores forged public SDK replies and a replacement legacy authorization hook', async () => {
    const realm = browser(() => false);
    realm.context.__truapi_network__ = async () => true;
    realm.context.__HOST_API_PORT__ = { onmessage: null, postMessage() {} };
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests).toEqual([]);
  });

  it('keeps decisions private when product code replaces transport and codec primitives', async () => {
    const authorized: string[] = [];
    const realm = browser(
      (url) => {
        authorized.push(url);
        return false;
      },
      undefined,
      'socket',
    );
    runInContext(
      `
      WebSocket.prototype.send = function () { throw new Error('intercepted socket'); };
      EventTarget.prototype.addEventListener = function () { throw new Error('intercepted listener'); };
      Object.defineProperty(MessageEvent.prototype, 'data', { get() { throw new Error('intercepted message'); } });
      const bytesPrototype = Object.getPrototypeOf(Uint8Array.prototype);
      for (const name of ['length', 'byteLength', 'byteOffset', 'buffer']) {
        Object.defineProperty(bytesPrototype, name, { get() { throw new Error('intercepted bytes'); } });
      }
      Uint8Array.prototype.set = function () { throw new Error('intercepted bytes'); };
      TextEncoder.prototype.encode = function () { throw new Error('intercepted URL'); };
      Map.prototype.set = function (key, value) { if (value.resolve) value.resolve(true); return this; };
      DataView.prototype.getUint8 = function () { return 1; };
    `,
      realm.context,
    );
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect({ authorized, requests: realm.requests }).toEqual({
      authorized: ['https://denied.example/data'],
      requests: [],
    });
  });

  it('does not invoke a substituted message data getter', async () => {
    const realm = browser(() => new Promise(() => {}));
    let read = false;
    const pending = realm.fetch('https://denied.example/data');
    realm.privatePort.onmessage!({
      get data() {
        read = true;
        return new Uint8Array();
      },
    } as MessageEvent);
    await expect(pending).rejects.toThrow('Network access is not allowed');
    expect({ read, requests: realm.requests }).toEqual({
      read: false,
      requests: [],
    });
  });

  it('sends no network request when Rust denies authorization', async () => {
    const realm = browser(async () => false);
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests).toEqual([]);
  });

  it('fails closed when the host transport is missing', async () => {
    const realm = browser();
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests).toEqual([]);
  });

  it('fails closed when the host authorization fails', async () => {
    const realm = browser(async () => {
      throw new Error('host disconnected');
    });
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests).toEqual([]);
  });

  it('leaves same-origin resources available without prompting', async () => {
    const realm = browser();
    await realm.fetch('/asset.json');
    expect(realm.requests.map((request) => request.url)).toEqual([
      `${origin}/asset.json`,
    ]);
  });

  it('does not consume a remote grant for same-origin fetches', async () => {
    const authorized: string[] = [];
    const realm = browser(async (url) => {
      authorized.push(url);
      return true;
    });
    await realm.fetch('/asset.json');
    expect(authorized).toEqual([]);
  });

  it('does not treat distinct native product origins as the same null origin', async () => {
    const realm = browser(undefined, 'polkadot://product/index.html');
    await realm.fetch('/asset.json');
    await expect(realm.fetch('polkadot://other/asset.json')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests.map((request) => request.url)).toEqual([
      'polkadot://product/asset.json',
    ]);
  });

  it('does not authorize non-HTTP remote requests', async () => {
    const authorized: string[] = [];
    const realm = browser(async (url) => {
      authorized.push(url);
      return true;
    });
    await expect(realm.fetch('file:///secret')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect({ authorized, requests: realm.requests }).toEqual({
      authorized: [],
      requests: [],
    });
  });

  it('consumes the bootstrap capability before product code runs', () => {
    const realm = browser(async () => true);
    realm.context.__truapi_network_port__ = { postMessage() {} };
    expect(realm.context.__truapi_network_port__).toBeUndefined();
  });

  it('uses current host decisions after a grant is revoked', async () => {
    let granted = true;
    const realm = browser(async () => granted);
    await realm.fetch('https://api.example/data');
    granted = false;
    await expect(realm.fetch('https://api.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests.map((request) => request.url)).toEqual([
      'https://api.example/data',
    ]);
  });

  it('snapshots the destination, headers and body before awaiting permission', async () => {
    let grant!: (allowed: boolean) => void;
    const authorized: string[] = [];
    const realm = browser((url) => {
      authorized.push(url);
      return new Promise<boolean>((resolve) => {
        grant = resolve;
      });
    });
    const url = new URL('https://api.example/data');
    const headers = new Headers({ 'x-product': 'original' });
    const options = { method: 'POST', body: 'original', headers };
    const pending = realm.fetch(url, options);
    url.hostname = 'denied.example';
    headers.set('x-product', 'changed');
    options.body = 'changed';
    grant(true);
    await pending;
    const request = realm.requests[0];
    expect({
      authorized,
      url: request.url,
      method: request.method,
      body: await request.text(),
      header: request.headers.get('x-product'),
    }).toEqual({
      authorized: ['https://api.example/data'],
      url: 'https://api.example/data',
      method: 'POST',
      body: 'original',
      header: 'original',
    });
  });

  it('preserves Request input and fetch overrides', async () => {
    const realm = browser(async () => true);
    const input = new Request('https://api.example/data', {
      method: 'POST',
      body: 'body',
      credentials: 'include',
    });
    await realm.fetch(input, {
      headers: { 'x-product': 'override' },
      redirect: 'error',
    });
    const request = realm.requests[0];
    expect({
      url: request.url,
      method: request.method,
      body: await request.text(),
      credentials: request.credentials,
      redirect: request.redirect,
      header: request.headers.get('x-product'),
    }).toEqual({
      url: 'https://api.example/data',
      method: 'POST',
      body: 'body',
      credentials: 'include',
      redirect: 'error',
      header: 'override',
    });
  });

  it('rejects an aborted request while permission is still pending', async () => {
    let grant!: (allowed: boolean) => void;
    const realm = browser(
      () =>
        new Promise<boolean>((resolve) => {
          grant = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = realm.fetch('https://api.example/data', {
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    grant(true);
    await Promise.resolve();
    expect(realm.requests).toEqual([]);
  });

  it('does not prompt for an already aborted request', async () => {
    const authorized: string[] = [];
    const realm = browser(async (url) => {
      authorized.push(url);
      return true;
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      realm.fetch('https://api.example/data', { signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect({ authorized, requests: realm.requests }).toEqual({
      authorized: [],
      requests: [],
    });
  });

  it('checks native Request URLs even when the product changes their getters', async () => {
    const authorized: string[] = [];
    const realm = browser(async (url) => {
      authorized.push(url);
      return false;
    });
    runInContext(
      `Object.defineProperty(Request.prototype, 'url', { get() { return '${origin}/asset.json'; } });`,
      realm.context,
    );
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect({ authorized, requests: realm.requests }).toEqual({
      authorized: ['https://denied.example/data'],
      requests: [],
    });
  });

  it('cannot forge approval by replacing Promise.prototype.then', async () => {
    const realm = browser(async () => false);
    runInContext(
      `
      const then = Promise.prototype.then;
      Promise.prototype.then = function (resolve) { resolve(true); };
      const pending = window.fetch('https://denied.example/data');
      Reflect.apply(then, pending, [() => {}, () => {}]);
    `,
      realm.context,
    );
    await Promise.resolve();
    expect(realm.requests).toEqual([]);
  });

  it('does not expose the permission callback to a substituted Promise species', async () => {
    const realm = browser(async () => false);
    runInContext(
      `
      const then = Promise.prototype.then;
      const NativePromise = Promise;
      let forge;
      Promise.prototype.constructor = {
        [Symbol.species]: function (executor) {
          return new NativePromise((resolve, reject) => {
            executor(resolve, reject);
            forge = () => resolve(true);
          });
        },
      };
      const pending = window.fetch('https://denied.example/data');
      if (forge) forge();
      Reflect.apply(then, pending, [() => {}, () => {}]);
    `,
      realm.context,
    );
    await Promise.resolve();
    expect(realm.requests).toEqual([]);
  });

  it('blocks workers that would otherwise have an unguarded fetch', () => {
    const realm = browser();
    expect({
      worker: realm.context.Worker,
      sharedWorker: realm.context.SharedWorker,
    }).toEqual({ worker: undefined, sharedWorker: undefined });
  });

  it('blocks WebTransport egress outside the HTTP request gate', () => {
    expect(browser().context.WebTransport).toBeUndefined();
  });
});
