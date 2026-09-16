import { freezeAndDelete, freezeValue } from './freeze.js';

function getter(prototype: object, name: string) {
  return Object.getOwnPropertyDescriptor(prototype, name)!.get!;
}

export function installFetchGate(win: Window & typeof globalThis): void {
  const nativeFetch = win.fetch.bind(win);
  const NativeRequest = win.Request;
  const NativeURL = win.URL;
  const NativePromise = win.Promise;
  const NetworkError = win.TypeError;
  const apply = Reflect.apply;
  const then = NativePromise.prototype.then;
  const requestUrl = getter(NativeRequest.prototype, 'url');
  const requestSignal = getter(NativeRequest.prototype, 'signal');
  const urlOrigin = getter(NativeURL.prototype, 'origin');
  const urlProtocol = getter(NativeURL.prototype, 'protocol');
  const urlHost = getter(NativeURL.prototype, 'host');
  const signalAborted = getter(win.AbortSignal.prototype, 'aborted');
  const signalReason = getter(win.AbortSignal.prototype, 'reason');
  const addEventListener = win.EventTarget.prototype.addEventListener;
  const removeEventListener = win.EventTarget.prototype.removeEventListener;
  const authorize = (win as unknown as { __truapi_network__?: unknown })
    .__truapi_network__;
  freezeAndDelete(win, '__truapi_network__');

  function origin(url: URL): string {
    const value = apply(urlOrigin, url, []);
    return value === 'null'
      ? `${apply(urlProtocol, url, [])}//${apply(urlHost, url, [])}`
      : value;
  }
  const productOrigin = origin(new NativeURL(win.location.href));

  freezeValue(
    win,
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) =>
      new NativePromise<Response>((resolve, reject) => {
        let signal: AbortSignal | undefined;
        let settled = false;

        function finish(): void {
          settled = true;
          if (signal) apply(removeEventListener, signal, ['abort', abort]);
        }

        function deny(): void {
          finish();
          reject(new NetworkError('Network access is not allowed'));
        }

        function abort(): void {
          if (settled) return;
          finish();
          reject(apply(signalReason, signal, []));
        }

        try {
          // Copy every request option before permission UI yields to product code.
          const request = new NativeRequest(input, init);
          const destination = apply(requestUrl, request, []);
          const url = new NativeURL(destination);
          const sameOrigin = origin(url) === productOrigin;
          const protocol = apply(urlProtocol, url, []);
          if (!sameOrigin && protocol !== 'http:' && protocol !== 'https:') {
            deny();
            return;
          }
          signal = apply(requestSignal, request, []);
          if (apply(signalAborted, signal, [])) {
            abort();
            return;
          }
          apply(addEventListener, signal, ['abort', abort]);

          function authorized(allowed: unknown): void {
            if (settled) return;
            if (allowed !== true) {
              deny();
              return;
            }
            finish();
            try {
              resolve(nativeFetch(request));
            } catch (error) {
              reject(error);
            }
          }

          if (typeof authorize === 'function') {
            // Native promise callbacks avoid product-controlled thenables and maps.
            apply(then, authorize(destination), [authorized, deny]);
          } else {
            authorized(sameOrigin);
          }
        } catch (error) {
          if (signal) deny();
          else reject(error);
        }
      }),
  );
}
