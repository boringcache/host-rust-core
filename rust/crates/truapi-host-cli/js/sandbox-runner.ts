import { chromium } from "playwright-core";
import type { WireProvider } from "@parity/truapi";
import { buildProductScript } from "./sandbox-build.ts";
import { startSandboxServer } from "./sandbox-server.ts";
import { wsProvider } from "./ws-provider.ts";

export { browserAssets } from "./browser-assets.ts";

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
  const server = await startSandboxServer({
    source: options.source,
    productId: options.productId,
    provider: options.provider,
  });
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
