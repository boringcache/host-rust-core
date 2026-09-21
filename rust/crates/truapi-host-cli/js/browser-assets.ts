import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BrowserAssets {
  container: string;
  client: string;
  bootstrap: string;
}

let assets: Promise<BrowserAssets> | undefined;

export function browserAssets(): Promise<BrowserAssets> {
  return (assets ??= (async () => {
    const directory = new URL("./sandbox-assets/", import.meta.url);
    if (await Bun.file(new URL("container.js", directory)).exists()) {
      const [container, client, bootstrap] = await Promise.all(
        ["container.js", "client.mjs", "bootstrap.js"].map((name) =>
          Bun.file(new URL(name, directory)).text(),
        ),
      );
      return { container, client, bootstrap };
    }
    if (import.meta.url.endsWith("/runner.js"))
      throw new Error(
        "Sandbox assets are missing beside runner.js; reinstall truapi-host",
      );
    return buildBrowserAssets(
      fileURLToPath(new URL("../../../../", import.meta.url)),
    );
  })());
}

export async function buildBrowserAssets(
  repository: string,
): Promise<BrowserAssets> {
  const { build } = await import("esbuild-wasm");

  async function bundle(
    entrypoint: string,
    format: "iife" | "esm",
    external: string[] = [],
  ): Promise<string> {
    const result = await build({
      entryPoints: [join(repository, entrypoint)],
      absWorkingDir: repository,
      bundle: true,
      platform: "browser",
      target: format === "iife" ? "es2020" : "es2022",
      format,
      external,
      define: { "process.env.NODE_ENV": '"production"' },
      write: false,
    });
    return result.outputFiles[0].text;
  }

  const [container, client, bootstrap] = await Promise.all([
    bundle("rust/crates/truapi-host-cli/js/browser-sandbox.ts", "iife"),
    bundle("js/packages/truapi/src/index.ts", "esm"),
    bundle("rust/crates/truapi-host-cli/js/browser-bootstrap.ts", "esm", [
      "@parity/truapi",
    ]),
  ]);
  return { container, client, bootstrap };
}
