import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProductScript } from "./sandbox-build.ts";

const directories: string[] = [];

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "truapi-product-build-"));
  directories.push(directory);
  const product = join(directory, "product");
  await mkdir(product);
  const script = join(product, "index.ts");
  await writeFile(script, source);
  return { directory, product, script };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

test("prepares TypeScript and local imports without evaluating product code", async () => {
  const { product, script } = await fixture(
    'import { answer } from "./answer.ts"; globalThis.productWasEvaluated = true; export default async () => answer;',
  );
  await writeFile(
    join(product, "answer.ts"),
    "export const answer: number = 42;",
  );
  const source = await buildProductScript(script);
  expect(source).toContain("42");
  expect(Object.hasOwn(globalThis, "productWasEvaluated")).toBe(false);
});

test("rejects imports of host capabilities", async () => {
  const { script } = await fixture(
    'import { readFile } from "node:fs/promises"; console.log(readFile);',
  );
  await expect(buildProductScript(script)).rejects.toThrow(
    /host module|node:fs/,
  );
});

test.each([
  ["parent traversal", "../secret.json"],
  ["file symlink", "./secret.json"],
  ["dependency directory symlink", "./node_modules/secret.json"],
])("rejects host files reached through %s", async (_, importPath) => {
  const { directory, product, script } = await fixture(
    `import secret from "${importPath}"; console.log(secret);`,
  );
  const secret = join(directory, "secret.json");
  await writeFile(secret, '{"secret":"host-only"}');
  if (importPath === "./secret.json")
    await symlink(secret, join(product, "secret.json"));
  if (importPath === "./node_modules/secret.json")
    await symlink(directory, join(product, "node_modules"));
  await expect(buildProductScript(script)).rejects.toThrow(
    /outside.*product|dependency.*symlink/,
  );
});

test("never embeds inherited environment secrets", async () => {
  const { script } = await fixture(
    "console.log(process.env.TRUAPI_BUILD_SECRET);",
  );
  process.env.TRUAPI_BUILD_SECRET = "not-for-the-product-7283";
  try {
    expect(await buildProductScript(script)).not.toContain(
      "not-for-the-product-7283",
    );
  } finally {
    delete process.env.TRUAPI_BUILD_SECRET;
  }
});

test("product macros cannot execute with launcher privileges", async () => {
  const { directory, product, script } = await fixture(
    'import { probe } from "./macro.ts" with { type: "macro" }; console.log(probe());',
  );
  const sentinel = join(directory, "macro-executed");
  await writeFile(
    join(product, "macro.ts"),
    `import { writeFileSync } from "node:fs";
     export function probe() {
       writeFileSync(${JSON.stringify(sentinel)}, "macro ran");
       return "macro-ran-with-host-privileges";
     }`,
  );
  await expect(buildProductScript(script)).rejects.toThrow(/macro/i);
  expect(await Bun.file(sentinel).exists()).toBe(false);
});
