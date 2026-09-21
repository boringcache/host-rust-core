import { chromium } from "playwright-core";
import type { WireProvider } from "@parity/truapi";
import { buildProductScript } from "./sandbox-build.ts";
import { wsProvider } from "./ws-provider.ts";

export interface BrowserScriptOptions {
  source: string;
  productId: string;
  provider: WireProvider;
  onConsole?: (level: string, message: string) => void;
  timeoutMs?: number;
}

export async function runBrowserScript(
  options: BrowserScriptOptions,
): Promise<void> {
  if (!Bun.semver.satisfies(Bun.version, ">=1.4.0"))
    throw new Error(
      `Sandboxed scripts require Bun 1.4.0 or newer for reliable browser startup (found ${Bun.version}); upgrade Bun and retry.`,
    );
  const server = await startSandboxServer(options);
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "SYSTEMROOT",
    "TMPDIR",
  ])
    if (process.env[name]) environment[name] = process.env[name]!;
  let browser;
  let failed = false;
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        env: environment,
      });
    } catch (error) {
      throw new Error(
        `Cannot start the sandboxed product browser. Run truapi-host install-browser and ensure Chromium sandboxing is supported. ${String(error)}`,
      );
    }
    const page = await browser.newPage({ acceptDownloads: false });
    page.on("console", (message) =>
      options.onConsole?.(message.type(), message.text()),
    );
    const pageFailure = new Promise<never>((_, reject) => {
      page.on("pageerror", reject);
      page.on("crash", () => reject(new Error("Product browser crashed")));
    });
    void pageFailure.catch(() => {});
    await page.goto(server.url);
    const completion = page
      .waitForFunction(
        () =>
          (window as Window & { __truapi_result?: { error: string | null } })
            .__truapi_result,
        undefined,
        { timeout: options.timeoutMs ?? 300_000 },
      )
      .catch(() => {
        throw new Error("Product script timed out");
      });
    const result = await (
      await Promise.race([completion, pageFailure])
    ).jsonValue();
    if (result!.error !== null) throw new Error(result!.error);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      if (!failed) throw error;
    } finally {
      server.stop();
    }
  }
}

export async function runSandboxScript(
  frameUrl: string,
  productId: string,
  scriptPath: string,
): Promise<void> {
  const source = await buildProductScript(scriptPath);
  const provider = wsProvider(frameUrl);
  try {
    await Promise.race([
      provider.opened,
      Bun.sleep(15_000).then(() => {
        throw new Error(`Timed out connecting to ${frameUrl}`);
      }),
    ]);
    await runBrowserScript({
      source,
      productId,
      provider,
      onConsole: (level, message) =>
        (level === "error" || level === "warning"
          ? console.error
          : console.log)(message),
    });
  } finally {
    provider.dispose();
  }
}

async function startSandboxServer(options: BrowserScriptOptions) {
  const directory = new URL(
    import.meta.url.endsWith("/runner.js")
      ? "./sandbox-assets/"
      : "../../../../target/dist/sandbox-assets/",
    import.meta.url,
  );
  const [container, client, bootstrap] = await Promise.all(
    ["container.js", "client.mjs", "bootstrap.js"].map((name) =>
      Bun.file(new URL(name, directory)).text(),
    ),
  ).catch(() => {
    throw new Error(
      "Sandbox assets are missing; run make cli-runner in a source checkout, or reinstall truapi-host",
    );
  });
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
    "container.js": container,
    "client.mjs": client,
    "bootstrap.js": bootstrap,
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
