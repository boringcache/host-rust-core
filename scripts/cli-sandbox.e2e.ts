import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "target/debug/truapi-host");
const directory = await mkdtemp(join(tmpdir(), "truapi-cli-sandbox-"));
const hits: string[] = [];
const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    hits.push(new URL(request.url).pathname);
    return new Response("authorized", {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  },
});

try {
  const script = join(directory, "product.ts");
  await writeFile(
    script,
    `
    assert(typeof Bun === 'undefined');
    assert(typeof process === 'undefined');
    const result = await truapi.permissions.requestRemotePermission({
      permission: { tag: 'Remote', value: { domains: ['127.0.0.1'] } },
    });
    assert(result.isOk());
    const granted = result.value.granted;
    if (granted) {
      assert(await (await fetch(${JSON.stringify(endpoint.url.href)})).text() === 'authorized');
    } else {
      try { await fetch(${JSON.stringify(endpoint.url.href)}); throw new Error('denial escaped'); }
      catch (error) { assert(error instanceof TypeError); }
    }
    console.log('permission=' + granted);
  `,
  );
  for (const [product, autoAccept, expectedHits] of [
    ["network-granted.testnet", true, 1],
    ["network-granted.testnet", false, 2],
    ["network-denied.testnet", false, 2],
  ] as const) {
    const child = Bun.spawn(
      [
        binary,
        "pairing-host",
        "--product-id",
        product,
        "--script",
        script,
        "--base-path",
        join(directory, "state"),
        ...(autoAccept ? ["--auto-accept"] : []),
      ],
      {
        env: {
          ...process.env,
          TRUAPI_HOST_NO_UPDATE: "1",
          TRUAPI_SCRIPT_MODE: "sandboxed",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 30_000);
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));
    const granted = product === "network-granted.testnet";
    if (
      status !== 0 ||
      !stdout.includes(`permission=${granted}`) ||
      hits.length !== expectedHits
    ) {
      throw new Error(
        JSON.stringify({ product, autoAccept, status, hits, stdout, stderr }),
      );
    }
    console.log(
      `${product}: auto-accept=${autoAccept}, granted=${granted}, received requests=${hits.length}`,
    );
  }
} finally {
  endpoint.stop(true);
  await rm(directory, { recursive: true, force: true });
}
