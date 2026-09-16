import { describe, expect, it } from 'bun:test';
import { createContext, runInContext } from 'node:vm';

const build = await Bun.build({
  entrypoints: [new URL('./index.ts', import.meta.url).pathname],
  target: 'browser',
  format: 'iife',
});
if (!build.success) throw new Error(build.logs.join('\n'));
const container = await build.outputs[0].text();
const origin = 'https://product.example';

function browser(
  authorize?: ((url: string) => unknown) | string,
  pageUrl = `${origin}/index.html`,
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
  const context = createContext({
    URL,
    Request: BrowserRequest,
    Response,
    AbortSignal,
    EventTarget,
    WebSocket: class {},
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
    __truapi_network__: authorize,
  });
  runInContext('window = globalThis', context);
  if (typeof authorize === 'string') {
    runInContext(`__truapi_network__ = ${authorize}`, context);
  }
  runInContext(container, context);
  return { context, requests, fetch: context.fetch as typeof fetch };
}

describe('container fetch authorization', () => {
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

  for (const decision of [
    false,
    undefined,
    null,
    1,
    'true',
    { allowed: true },
  ]) {
    it(`sends no request when authorization returns ${JSON.stringify(decision)}`, async () => {
      const realm = browser(async () => decision);
      await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
        'Network access is not allowed',
      );
      expect(realm.requests).toEqual([]);
    });
  }

  it('fails closed when the host authorization hook is missing', async () => {
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

  it('does not accept a forged thenable as a host reply', async () => {
    const realm = browser(() => ({
      then: (resolve: (value: boolean) => void) => resolve(true),
    }));
    await expect(realm.fetch('https://denied.example/data')).rejects.toThrow(
      'Network access is not allowed',
    );
    expect(realm.requests).toEqual([]);
  });

  it('does not accept an unwrapped boolean as a host reply', async () => {
    const realm = browser(() => true);
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

  it('refreshes the installed host gate for same-origin fetches too', async () => {
    const authorized: string[] = [];
    const realm = browser(async (url) => {
      authorized.push(url);
      return true;
    });
    await realm.fetch('/asset.json');
    expect(authorized).toEqual([`${origin}/asset.json`]);
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
    realm.context.__truapi_network__ = async () => true;
    expect(realm.context.__truapi_network__).toBeUndefined();
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
    const realm = browser('() => Promise.resolve(false)');
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
    const realm = browser('() => Promise.resolve(false)');
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
      forge();
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
