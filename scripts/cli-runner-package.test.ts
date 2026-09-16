import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "truapi-cli-package-"));
  const result = Bun.spawnSync(
    ["make", "cli-runner", `CLI_DIST_DIR=${directory}`],
    { cwd: repository },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("ships each browser asset and the matching browser driver", async () => {
  const files = [
    "runner.js",
    "sandbox-assets/container.js",
    "sandbox-assets/client.mjs",
    "sandbox-assets/bootstrap.js",
    "node_modules/playwright-core/cli.js",
    "node_modules/playwright-core/browsers.json",
    "node_modules/esbuild-wasm/esbuild.wasm",
  ];
  const sizes = await Promise.all(
    files.map(async (file) => (await readFile(join(directory, file))).length),
  );
  expect(sizes.every((size) => size > 0)).toBe(true);
  const manifest = await Bun.file(
    join(directory, "node_modules/playwright-core/package.json"),
  ).json();
  expect(manifest.version).toBe("1.59.1");
  const builder = await Bun.file(
    join(directory, "node_modules/esbuild-wasm/package.json"),
  ).json();
  expect(builder.version).toBe("0.28.1");
});

it("resolves the packaged runner without a source checkout", () => {
  const result = Bun.spawnSync(["bun", join(directory, "runner.js")], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  });
  expect({
    status: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  }).toEqual({
    status: 1,
    output: expect.stringContaining("TRUAPI_FRAME_URL must be set"),
  });
});

it("ships a runnable browser installer with its dynamic dependencies", () => {
  const result = Bun.spawnSync(
    [
      "bun",
      join(directory, "node_modules/playwright-core/cli.js"),
      "--version",
    ],
    { cwd: tmpdir() },
  );
  expect({
    status: result.exitCode,
    output: result.stdout.toString().trim(),
  }).toEqual({ status: 0, output: "Version 1.59.1" });
});

it("produces a valid browser client module with complete exports", () => {
  const result = Bun.spawnSync([
    "node",
    "--check",
    join(directory, "sandbox-assets/client.mjs"),
  ]);
  expect({ status: result.exitCode, error: result.stderr.toString() }).toEqual({
    status: 0,
    error: "",
  });
});

it("ships a portable product builder that works without a checkout", () => {
  const entrypoint = join(directory, "node_modules/esbuild-wasm/lib/main.js");
  const source = `const { transform, stop } = require(${JSON.stringify(entrypoint)});
    const result = await transform('const value: string = "browser";', { loader: 'ts' });
    console.log(result.code.trim());
    stop();`;
  const result = Bun.spawnSync(["bun", "--eval", source], { cwd: tmpdir() });
  expect({
    status: result.exitCode,
    output: result.stdout.toString().trim(),
  }).toEqual({ status: 0, output: 'const value = "browser";' });
});

it("fails closed when an installed sandbox asset is missing", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message() {} },
  });
  const asset = join(directory, "sandbox-assets/container.js");
  const backup = `${asset}.backup`;
  const script = join(directory, "product.ts");
  await writeFile(script, 'console.log("product must not run");');
  await rename(asset, backup);
  try {
    const child = Bun.spawn(["bun", join(directory, "runner.js")], {
      cwd: tmpdir(),
      env: {
        PATH: process.env.PATH,
        TRUAPI_FRAME_URL: `ws://127.0.0.1:${server.port}`,
        TRUAPI_PRODUCT_ID: "package-test.dot",
        TRUAPI_SCRIPT: script,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, output, error }).toEqual({
      status: 1,
      output: "",
      error: expect.stringContaining(
        "Sandbox assets are missing beside runner.js; reinstall truapi-host",
      ),
    });
  } finally {
    await rename(backup, asset);
    server.stop(true);
  }
});
