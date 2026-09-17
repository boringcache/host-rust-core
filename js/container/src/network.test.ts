import { describe, expect, it } from 'bun:test';
import { createContext, runInContext } from 'node:vm';
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
} from '@parity/truapi';
import {
  VersionedAuthorizeNetworkAccessRequest,
  VersionedAuthorizeNetworkAccessResponse,
  VersionedAuthorizeNetworkAccessError,
  VersionedAuthorizeWebRtcRequest,
  VersionedAuthorizeWebRtcResponse,
  VersionedAuthorizeWebRtcError,
  VersionedAuthorizeMediaCaptureRequest,
  VersionedAuthorizeMediaCaptureResponse,
  VersionedAuthorizeMediaCaptureError,
} from '../../packages/truapi/src/generated/internal.js';
import {
  PERMISSIONS_AUTHORIZE_NETWORK_ACCESS,
  PERMISSIONS_AUTHORIZE_WEB_RTC,
  PERMISSIONS_AUTHORIZE_MEDIA_CAPTURE,
} from '@parity/truapi/wire-table';

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
  authorizeWebRtc: () => boolean | Promise<boolean> = () => false,
  authorizeMedia: (request: { audio: boolean; video: boolean }) => boolean | Promise<boolean> = () => false,
  mediaAllowed = true,
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
    const webRtc = decoded.payload.methodId === PERMISSIONS_AUTHORIZE_WEB_RTC.method;
    const media = decoded.payload.methodId === PERMISSIONS_AUTHORIZE_MEDIA_CAPTURE.method;
    expect({
      trait: decoded.payload.traitId,
      method: decoded.payload.methodId,
      kind: 'request',
    }).toEqual(media ? PERMISSIONS_AUTHORIZE_MEDIA_CAPTURE : webRtc ? PERMISSIONS_AUTHORIZE_WEB_RTC : PERMISSIONS_AUTHORIZE_NETWORK_ACCESS);
    const url = webRtc || media ? null : VersionedAuthorizeNetworkAccessRequest.dec(
      decoded.payload.value,
    ).value.url;
    if (webRtc) {
      expect(VersionedAuthorizeWebRtcRequest.dec(decoded.payload.value)).toEqual({ tag: 'V1' });
    }
    Promise.resolve(media
      ? authorizeMedia(VersionedAuthorizeMediaCaptureRequest.dec(decoded.payload.value).value)
      : url === null ? authorizeWebRtc() : authorize!(url)).then(
      (allowed) => {
        const reply = encodeWireMessage({
          requestId: decoded.requestId,
          payload: {
            ...decoded.payload,
            messageType: MESSAGE_TYPE_RESPONSE,
            value: scale
              .Result(
                media ? VersionedAuthorizeMediaCaptureResponse : webRtc ? VersionedAuthorizeWebRtcResponse : VersionedAuthorizeNetworkAccessResponse,
                scale.CallError(media ? VersionedAuthorizeMediaCaptureError : webRtc ? VersionedAuthorizeWebRtcError : VersionedAuthorizeNetworkAccessError),
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
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    private state = 0;
    private binary = 'blob';
    get url() { return this.destination; }
    get readyState() { return this.state; }
    get bufferedAmount() { return 0; }
    get extensions() { return ''; }
    get protocol() { return ''; }
    get binaryType() { return this.binary; }
    set binaryType(value: string) { this.binary = value; }
    constructor(private destination: string) {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.state = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(frame: Uint8Array | string) {
      if (this.destination === 'ws://127.0.0.1:1234/?t=secret') {
        handle(frame as Uint8Array, (data) =>
          this.dispatchEvent(new BrowserMessage('message', { data: data.buffer })),
        );
      } else {
        this.dispatchEvent(new BrowserMessage('message', { data: frame }));
      }
    }
    close() {
      this.state = 3;
      queueMicrotask(() => this.dispatchEvent(new CloseEvent('close', { code: 1000, wasClean: true })));
    }
  }
  const context = createContext({
    URL,
    Request: BrowserRequest,
    Response,
    AbortSignal,
    DOMException,
    Event,
    CloseEvent,
    Blob,
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
    __truapi_policy__: { mediaAllowed },
    __truapi_network_port__:
      authorize && transport === 'port' ? privatePort : undefined,
    __truapi_localhost:
      authorize && transport === 'socket'
        ? { url: 'ws://127.0.0.1:1234/?t=secret' }
        : undefined,
  });
  runInContext('window = globalThis', context);
  runInContext(`
    window.mediaCalls = [];
    window.navigator.mediaDevices = new (class {
      getUserMedia(constraints) {
        mediaCalls.push(constraints);
        return Promise.resolve('capture');
      }
    })();
    window.RTCPeerConnection = class {
      constructor(config = {}) { this.config = { ...config, iceCandidatePoolSize: config.iceCandidatePoolSize ?? 0 }; }
      getConfiguration() { return { ...this.config }; }
      setConfiguration(config) { this.config = { ...config }; }
      createOffer() { return Promise.resolve({ type: 'offer', sdp: 'native' }); }
      createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'native' }); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      addIceCandidate() { return Promise.resolve(); }
      close() {}
    };
  `, context);
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
  it('uses one Remote decision per WebSocket connection over either private transport', async () => {
    for (const transport of ['port', 'socket'] as const) {
      const authorized: string[] = [];
      const realm = browser((url) => {
        authorized.push(url);
        return authorized.length === 1;
      }, undefined, transport);
      await runInContext(`
        window.remote = new WebSocket('wss://api.example/socket');
        new Promise((resolve, reject) => {
          remote.addEventListener('open', resolve, { once: true });
          remote.addEventListener('error', reject, { once: true });
        });
      `, realm.context);
      const result = await runInContext(`
        new Promise(resolve => {
          remote.addEventListener('message', event => resolve({ data: event.data, target: event.target === remote }), { once: true });
          remote.send('first');
        });
      `, realm.context);
      expect(result).toEqual({ data: 'first', target: true });
      await runInContext(`
        window.denied = new WebSocket.prototype.constructor('wss://api.example/socket');
        new Promise(resolve => denied.addEventListener('close', resolve, { once: true }));
      `, realm.context);
      const second = await runInContext(`
        new Promise(resolve => {
          remote.addEventListener('message', event => resolve(event.data), { once: true });
          remote.send('still open');
        });
      `, realm.context);
      expect({
        authorized,
        sockets: realm.sockets.map(socket => socket.url),
        second,
      }).toEqual({
        authorized: ['wss://api.example/socket', 'wss://api.example/socket'],
        sockets: transport === 'socket'
          ? ['ws://127.0.0.1:1234/?t=secret', 'wss://api.example/socket']
          : ['wss://api.example/socket'],
        second: 'still open',
      });
    }
  });

  it('reserves only the exact private bridge endpoint without a Remote decision', async () => {
    const authorized: string[] = [];
    const realm = browser(url => { authorized.push(url); return false; }, undefined, 'socket');
    runInContext(`window.bridge = new WebSocket('ws://127.0.0.1:1234/?t=secret');`, realm.context);
    await runInContext(`
      window.changed = new bridge.constructor('ws://127.0.0.1:1234/?t=other');
      new Promise(resolve => changed.addEventListener('close', resolve, { once: true }));
    `, realm.context);
    expect({ authorized, sockets: realm.sockets.map(socket => socket.url) }).toEqual({
      authorized: ['ws://127.0.0.1:1234/?t=other'],
      sockets: ['ws://127.0.0.1:1234/?t=secret', 'ws://127.0.0.1:1234/?t=secret'],
    });
  });

  it('authorizes each capture over the private Rust channel', async () => {
    for (const transport of ['port', 'socket'] as const) {
      const decisions: { audio: boolean; video: boolean }[] = [];
      const realm = browser(() => false, undefined, transport, (bytes) => bytes,
        () => false, (request) => {
          decisions.push(request);
          return decisions.length === 1;
        });
      const capture = () => runInContext(
        'navigator.mediaDevices.getUserMedia({ audio: true, video: true })', realm.context);
      expect(await capture()).toBe('capture');
      await expect(capture()).rejects.toMatchObject({ name: 'NotAllowedError' });
      expect({ decisions, captures: realm.context.mediaCalls }).toEqual({
        decisions: [{ audio: true, video: true }, { audio: true, video: true }],
        captures: [{ audio: true, video: true }],
      });
    }
  });

  it('lets hosts disable capture without closing fetch authorization', async () => {
    const realm = browser(() => true, undefined, 'port', (bytes) => bytes,
      () => false, () => { throw new Error('Unsupported media must not reach the host'); }, false);
    await expect(runInContext(
      'navigator.mediaDevices.getUserMedia({ video: true })', realm.context,
    )).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(realm.sent).toEqual([]);
    await realm.fetch('https://api.example/data');
    expect(realm.requests.map(request => request.url)).toEqual(['https://api.example/data']);
  });

  it('does not accept a WebRTC reply as capture approval', async () => {
    const realm = browser(() => false, undefined, 'port', (bytes) => {
      const message = decodeWireMessage(bytes)._unsafeUnwrap();
      message.payload.methodId = PERMISSIONS_AUTHORIZE_WEB_RTC.method;
      return encodeWireMessage(message)._unsafeUnwrap();
    }, () => false, () => true);
    await expect(runInContext(
      'navigator.mediaDevices.getUserMedia({ video: true })', realm.context,
    )).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(realm.context.mediaCalls).toEqual([]);
  });

  it('authorizes each peer connection over the private Rust channel', async () => {
    let authorizations = 0;
    const realm = browser(() => false, undefined, 'port', (bytes) => bytes,
      () => ++authorizations === 1);
    const first = runInContext('new RTCPeerConnection()', realm.context);
    expect(await first.createOffer()).toEqual({ type: 'offer', sdp: 'native' });
    expect(await first.createOffer()).toEqual({ type: 'offer', sdp: 'native' });
    const second = runInContext('new RTCPeerConnection()', realm.context);
    await expect(second.createOffer()).rejects.toThrow('WebRTC access is not allowed');
    expect({ authorizations, fetches: realm.requests.length }).toEqual({
      authorizations: 2,
      fetches: 0,
    });
    first.close();
    second.close();
  });

  it('does not accept a fetch approval as a peer-connection approval', async () => {
    const realm = browser(() => true, `${origin}/index.html`, 'port', (bytes) => {
      const decoded = decodeWireMessage(bytes)._unsafeUnwrap();
      return encodeWireMessage({
        ...decoded,
        payload: { ...decoded.payload, methodId: PERMISSIONS_AUTHORIZE_NETWORK_ACCESS.method },
      })._unsafeUnwrap();
    }, () => true);
    const connection = runInContext('new RTCPeerConnection()', realm.context);
    await expect(connection.createOffer()).rejects.toThrow('WebRTC access is not allowed');
    connection.close();
  });

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
    expect({
      requests: realm.requests,
      peerConnection: realm.context.RTCPeerConnection,
    }).toEqual({ requests: [], peerConnection: undefined });
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
