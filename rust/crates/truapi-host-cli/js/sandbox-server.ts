import type { WireProvider } from "@parity/truapi";
import { browserAssets } from "./browser-assets.ts";

export async function startSandboxServer(options: {
  productId: string;
  source: string;
  provider: WireProvider;
}) {
  const assets = await browserAssets();
  const prefix = `/${crypto.randomUUID()}/`;
  let connected = false;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeClose: (() => void) | undefined;

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribeClose?.();
    options.provider.dispose();
  }

  const scripts: Record<string, string> = {
    "container.js": assets.container,
    "client.mjs": assets.client,
    "bootstrap.js": assets.bootstrap,
    "product.mjs": options.source,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.origin !== server.url.origin || !url.pathname.startsWith(prefix))
        return new Response("Not found", { status: 404 });
      const path = url.pathname.slice(prefix.length);
      if (path === "frames") {
        if (connected || request.headers.get("origin") !== server.url.origin)
          return new Response("Invalid script connection", { status: 403 });
        if (server.upgrade(request)) {
          connected = true;
          return;
        }
        return new Response("WebSocket required", { status: 400 });
      }
      if (Object.hasOwn(scripts, path))
        return new Response(scripts[path], {
          headers: {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-store",
          },
        });
      if (path !== "") return new Response("Not found", { status: 404 });
      const frameUrl = new URL(`${prefix}frames`, server.url);
      frameUrl.protocol = "ws:";
      const productId = JSON.stringify(options.productId).replaceAll(
        "<",
        "\\u003c",
      );
      return new Response(
        `<!doctype html><script>window.__truapi_cli_frame_url__=${JSON.stringify(frameUrl.href)};window.__truapi_product_id__=${productId};</script><script src="container.js"></script><script type="importmap">{"imports":{"@parity/truapi":"${prefix}client.mjs"}}</script><script type="module" src="bootstrap.js"></script>`,
        {
          headers: { "Content-Type": "text/html", "Cache-Control": "no-store" },
        },
      );
    },
    websocket: {
      maxPayloadLength: 64 * 1024 * 1024,
      open(socket) {
        unsubscribe = options.provider.subscribe((message) =>
          socket.send(message),
        );
        unsubscribeClose = options.provider.subscribeClose?.(() =>
          socket.close(),
        );
      },
      message(_socket, message) {
        options.provider.postMessage(
          new Uint8Array(
            typeof message === "string" ? Buffer.from(message) : message,
          ),
        );
      },
      close: dispose,
    },
  });
  return {
    url: new URL(prefix, server.url).href,
    stop() {
      dispose();
      server.stop(true);
    },
  };
}
