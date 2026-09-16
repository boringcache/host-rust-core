import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  ];
  const sizes = await Promise.all(
    files.map(async (file) => (await readFile(join(directory, file))).length),
  );
  expect(sizes.every((size) => size > 0)).toBe(true);
  const manifest = await Bun.file(
    join(directory, "node_modules/playwright-core/package.json"),
  ).json();
  expect(manifest.version).toBe("1.59.1");
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
