import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const repository = resolve(import.meta.dir, "..");
const destination = resolve(process.argv[2] ?? join(repository, "target/dist"));
const require = createRequire(import.meta.url);
const driver = dirname(require.resolve("playwright-core/package.json"));
const manifest = JSON.parse(
  await readFile(join(driver, "package.json"), "utf8"),
);
const expected = (await Bun.file(join(repository, "package.json")).json())
  .devDependencies["playwright-core"];
if (manifest.version !== expected) {
  throw new Error(
    `Expected playwright-core ${expected}, found ${manifest.version}; run npm ci --ignore-scripts`,
  );
}

await mkdir(destination, { recursive: true });
const staging = await mkdtemp(join(destination, ".runner-"));
try {
  const runner = await Bun.build({
    entrypoints: [join(repository, "rust/crates/truapi-host-cli/js/runner.ts")],
    target: "bun",
    format: "esm",
    external: ["playwright-core", "esbuild"],
    env: "disable",
  });
  if (!runner.success || runner.outputs.length !== 1) {
    throw new Error(`Cannot bundle runner: ${runner.logs.join("\n")}`);
  }
  await Bun.write(join(staging, "runner.js"), runner.outputs[0]);
  for (const [entrypoint, output, target, format, external] of [
    [
      "js/container/src/index.ts",
      "sandbox-assets/container.js",
      "es2020",
      "iife",
      [],
    ],
    [
      "js/packages/truapi/src/index.ts",
      "sandbox-assets/client.mjs",
      "es2022",
      "esm",
      [],
    ],
    [
      "rust/crates/truapi-host-cli/js/browser-bootstrap.ts",
      "sandbox-assets/bootstrap.js",
      "es2022",
      "esm",
      ["@parity/truapi"],
    ],
  ] as const) {
    const result = await build({
      entryPoints: [join(repository, entrypoint)],
      bundle: true,
      platform: "browser",
      target,
      format,
      external: [...external],
      define: { "process.env.NODE_ENV": '"production"' },
      write: false,
    });
    await Bun.write(join(staging, output), result.outputFiles[0].contents);
  }
  await cp(driver, join(staging, "node_modules/playwright-core"), {
    recursive: true,
    dereference: true,
  });
  for (const name of ["runner.js", "sandbox-assets", "node_modules"]) {
    await rm(join(destination, name), { recursive: true, force: true });
    await rename(join(staging, name), join(destination, name));
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
