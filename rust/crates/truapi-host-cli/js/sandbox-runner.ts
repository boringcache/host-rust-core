import { chromium, type CDPSession, type Page } from "playwright-core";
import { fileURLToPath } from "node:url";
import {
  createClient,
  createTransport,
  type WireProvider,
} from "../../../../js/packages/truapi/src/index.ts";
import { buildProductScript } from "./sandbox-build.ts";
import { buildBrowserAssets, type BrowserAssets } from "./browser-assets.ts";
import { wsProvider } from "./ws-provider.ts";

export interface BrowserScriptOptions {
  source: string;
  productId: string;
  authorize: (url: string) => Promise<boolean>;
  provider: WireProvider;
  onConsole?: (level: string, message: string) => void;
  timeoutMs?: number;
}

let assetPromise: Promise<BrowserAssets> | undefined;
export function browserAssets(): Promise<BrowserAssets> {
  return (assetPromise ??= (async () => {
    const directory = new URL("./sandbox-assets/", import.meta.url);
    if (await Bun.file(new URL("container.js", directory)).exists()) {
      const [container, client, bootstrap] = await Promise.all([
        Bun.file(new URL("container.js", directory)).text(),
        Bun.file(new URL("client.mjs", directory)).text(),
        Bun.file(new URL("bootstrap.js", directory)).text(),
      ]);
      return { container, client, bootstrap };
    }
    if (import.meta.url.endsWith("/runner.js")) {
      throw new Error(
        "Sandbox assets are missing beside runner.js; reinstall truapi-host",
      );
    }
    return buildBrowserAssets(
      fileURLToPath(new URL("../../../../", import.meta.url)),
    );
  })());
}

function browserEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "SYSTEMROOT",
    "TMPDIR",
  ]) {
    if (process.env[name]) environment[name] = process.env[name]!;
  }
  return environment;
}

export async function runBrowserScript(
  options: BrowserScriptOptions,
): Promise<void> {
  const assets = await browserAssets();
  const origin = `http://${crypto.randomUUID()}.localhost`;
  const nonce = crypto.randomUUID();
  const headers = [
    {
      name: "Content-Security-Policy",
      value: `sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'self' 'unsafe-eval' 'nonce-${nonce}'; connect-src http: https:; img-src http: https: data:; style-src 'unsafe-inline'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    },
    { name: "X-DNS-Prefetch-Control", value: "off" },
    { name: "Cache-Control", value: "no-store" },
    { name: "Referrer-Policy", value: "no-referrer" },
  ];
  const resources = new Map([
    [
      "/",
      {
        type: "text/html",
        body: `<!doctype html><meta charset="utf-8"><title>TrUAPI product</title><script type="importmap" nonce="${nonce}">{"imports":{"@parity/truapi":"${origin}/client.mjs"}}</script>`,
      },
    ],
    ["/client.mjs", { type: "text/javascript", body: assets.client }],
    ["/bootstrap.js", { type: "text/javascript", body: assets.bootstrap }],
    ["/product.mjs", { type: "text/javascript", body: options.source }],
  ]);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      env: browserEnvironment(),
      args: ["--dns-prefetch-disable", "--disable-quic"],
    });
  } catch (error) {
    throw new Error(
      `Cannot start the sandboxed product browser. Run truapi-host install-browser and ensure Chromium sandboxing is supported. ${String(error)}`,
    );
  }
  let unsubscribe: (() => void) | undefined;
  let unsubscribeClose: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Startup can fail before the caller begins awaiting script completion.
  void completion.catch(() => {});
  const fail = (error: unknown) => {
    if (done) return;
    done = true;
    rejectDone(error instanceof Error ? error : new Error(String(error)));
  };
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.grantPermissions(["local-network-access"]);
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    context.on("page", (other) => {
      if (other !== page) void other.close();
    });
    page.on("crash", () => fail(new Error("Product browser crashed")));
    page.on("close", () =>
      fail(new Error("Product browser closed before completion")),
    );
    page.on("pageerror", fail);
    page.on("console", (message) =>
      options.onConsole?.(message.type(), message.text()),
    );
    const session = await context.newCDPSession(page);
    let firstDocument = true;
    session.on("Fetch.requestPaused", (event) => {
      void (async () => {
        const url = new URL(event.request.url);
        if (event.resourceType === "Document") {
          if (!firstDocument || url.href !== `${origin}/`)
            return denyRequest(session, event.requestId);
          firstDocument = false;
        }
        if (url.origin === origin) {
          const resource = !url.search
            ? resources.get(url.pathname)
            : undefined;
          if (!resource) return denyRequest(session, event.requestId);
          await session.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: 200,
            responseHeaders: [
              ...headers,
              { name: "Content-Type", value: resource.type },
            ],
            body: Buffer.from(resource.body).toString("base64"),
          });
        } else if (
          ["http:", "https:"].includes(url.protocol) &&
          (await options.authorize(url.href))
        ) {
          await session.send("Fetch.continueRequest", {
            requestId: event.requestId,
          });
        } else {
          await denyRequest(session, event.requestId);
        }
      })().catch((error) => {
        void denyRequest(session, event.requestId).catch(() => {});
        fail(error);
      });
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });

    await page.exposeBinding(
      "__truapi_authorize__",
      async ({ frame }, input: unknown) => {
        if (frame !== page.mainFrame() || typeof input !== "string")
          return false;
        const url = new URL(input);
        return (
          url.origin === origin ||
          (["http:", "https:"].includes(url.protocol) &&
            (await options.authorize(url.href)))
        );
      },
    );
    await page.exposeBinding(
      "__truapi_send__",
      ({ frame }, message: unknown) => {
        if (
          frame !== page.mainFrame() ||
          !Array.isArray(message) ||
          message.length > 64 * 1024 * 1024 ||
          !message.every(
            (value) => Number.isInteger(value) && value >= 0 && value <= 255,
          )
        ) {
          throw new Error("Invalid product frame");
        }
        options.provider.postMessage(Uint8Array.from(message));
      },
    );
    await page.exposeBinding(
      "__truapi_complete__",
      ({ frame }, error: unknown) => {
        if (frame !== page.mainFrame() || done) return;
        if (error !== null) return fail(new Error(String(error)));
        done = true;
        resolveDone();
      },
    );
    const bootstrap = `(() => {
      if (window !== window.top) return;
      const send = window.__truapi_send__;
      const channel = new MessageChannel();
      channel.port2.onmessage = event => send(Array.from(new Uint8Array(event.data)));
      channel.port2.start();
      window.addEventListener('__truapi_frame__', event => channel.port2.postMessage(new Uint8Array(event.detail)));
      window.__HOST_API_PORT__ = channel.port1;
      window.__HOST_WEBVIEW_MARK__ = true;
      window.__truapi_product_id__ = ${JSON.stringify(options.productId)};
      window.__truapi_network__ = window.__truapi_authorize__;
      window.__truapi_policy__ = { webRtcAllowed: false };
      delete window.__truapi_authorize__;
      delete window.__truapi_send__;
    })();`;
    await page.addInitScript({ content: `${bootstrap}\n${assets.container}` });
    let ready = false;
    const pending: Uint8Array[] = [];
    unsubscribe = options.provider.subscribe((message) => {
      if (ready) void deliverFrame(page, message).catch(fail);
      else pending.push(message.slice());
    });
    unsubscribeClose = options.provider.subscribeClose?.((error) =>
      fail(error),
    );
    timer = setTimeout(
      () => fail(new Error("Product script timed out")),
      options.timeoutMs ?? 300_000,
    );
    await page.goto(`${origin}/`);
    ready = true;
    for (const message of pending.splice(0)) await deliverFrame(page, message);
    void page
      .addScriptTag({ type: "module", url: `${origin}/bootstrap.js` })
      .catch(fail);
    await completion;
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    unsubscribe?.();
    unsubscribeClose?.();
    await browser.close();
  }
}

async function denyRequest(
  session: CDPSession,
  requestId: string,
): Promise<void> {
  await session.send("Fetch.failRequest", {
    requestId,
    errorReason: "BlockedByClient",
  });
}

async function deliverFrame(page: Page, message: Uint8Array): Promise<void> {
  await page.evaluate(
    (bytes) =>
      window.dispatchEvent(
        new CustomEvent("__truapi_frame__", { detail: bytes }),
      ),
    Array.from(message),
  );
}

export async function runSandboxScript(
  frameUrl: string,
  productId: string,
  scriptPath: string,
): Promise<void> {
  const source = await buildProductScript(scriptPath);
  const provider = wsProvider(frameUrl);
  const authorizationProvider = wsProvider(frameUrl);
  const client = createClient(createTransport(authorizationProvider));
  const timer = setTimeout(() => {
    console.error(`[runner] timed out connecting to ${frameUrl}`);
    process.exit(2);
  }, 15_000);
  try {
    await Promise.all([provider.opened, authorizationProvider.opened]);
    clearTimeout(timer);
    await runBrowserScript({
      source,
      productId,
      provider,
      authorize: async (url) => {
        const domain = new URL(url).hostname;
        const result = await client.permissions.requestRemotePermission({
          permission: { tag: "Remote", value: { domains: [domain] } },
        });
        return result.isOk() && result.value.granted;
      },
      onConsole: (level, message) =>
        (level === "error" || level === "warning"
          ? console.error
          : console.log)(message),
    });
  } finally {
    clearTimeout(timer);
    provider.dispose();
    authorizationProvider.dispose();
  }
}
