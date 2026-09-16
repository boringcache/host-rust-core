import { expect, test } from "bun:test";
import type { WireProvider } from "@parity/truapi";
import { runBrowserScript } from "./sandbox-runner.ts";

const provider = {
  postMessage() {},
  subscribe() {
    return () => {};
  },
  dispose() {},
} satisfies WireProvider;

test("runs a product with CLI helpers but no host runtime capabilities", async () => {
  const messages: string[] = [];
  await runBrowserScript({
    source: `
      assert(host.productId === 'sandbox.testnet');
      assert(host.productAccount(2).derivationIndex.value === 2);
      assert(typeof truapi.permissions.requestRemotePermission === 'function');
      for (const name of ['process', 'Bun', 'require', 'Worker', 'SharedWorker', 'WebTransport', 'RTCPeerConnection']) {
        assert(typeof globalThis[name] === 'undefined', name + ' must be unavailable');
      }
      document.body.innerHTML = '<iframe></iframe>';
      const child = document.querySelector('iframe').contentWindow;
      for (const name of ['Worker', 'SharedWorker', 'RTCPeerConnection']) {
        assert(typeof child[name] === 'undefined', name + ' must be unavailable in blank frames');
      }
      export default async (context) => console.log('completed ' + context.productId);
    `,
    productId: "sandbox.testnet",
    provider,
    authorize: async () => false,
    onConsole: (_, message) => messages.push(message),
    timeoutMs: 10_000,
  });
  expect(messages).toContain("completed sandbox.testnet");
}, 20_000);

test("denied fetch and image requests never reach the server", async () => {
  const hits: string[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      return new Response("unexpected", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    },
  });
  try {
    await runBrowserScript({
      source: `
        const endpoint = ${JSON.stringify(endpoint.url.href)};
        try { await fetch(endpoint + 'fetch'); throw new Error('unexpected success'); }
        catch (error) { assert(error instanceof TypeError); }
        await new Promise((resolve, reject) => {
          const image = new Image(); image.onerror = resolve; image.onload = () => reject(new Error('image escaped'));
          image.src = endpoint + 'image';
        });
      `,
      productId: "sandbox.testnet",
      provider,
      authorize: async () => false,
      timeoutMs: 10_000,
    });
    expect(hits).toEqual([]);
  } finally {
    endpoint.stop(true);
  }
}, 20_000);

test("revocation blocks the next fetch after an authorized response", async () => {
  const hits: string[] = [];
  let allowed = true;
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(new URL(request.url).pathname);
      allowed = false;
      return new Response("authorized", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    },
  });
  try {
    await runBrowserScript({
      source: `
        const endpoint = ${JSON.stringify(endpoint.url.href)};
        assert(await (await fetch(endpoint + 'allowed')).text() === 'authorized');
        try { await fetch(endpoint + 'revoked'); throw new Error('unexpected success'); }
        catch (error) { assert(error instanceof TypeError); }
      `,
      productId: "sandbox.testnet",
      provider,
      authorize: async () => allowed,
      timeoutMs: 10_000,
    });
    expect(hits).toEqual(["/allowed"]);
  } finally {
    endpoint.stop(true);
  }
}, 20_000);

for (const grantDestination of [false, true]) {
  test(`redirects ${grantDestination ? "reach an authorized" : "cannot reach a denied"} destination`, async () => {
    const hits: string[] = [];
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits.push("destination");
        return new Response("authorized", {
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      },
    });
    const destination = new URL(target.url);
    destination.hostname = "localhost";
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits.push("allowed");
        return new Response(null, {
          status: 302,
          headers: {
            Location: destination.href,
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    });
    try {
      await runBrowserScript({
        source: `
        const endpoint = ${JSON.stringify(redirect.url.href)};
        if (${grantDestination}) {
          assert(await (await fetch(endpoint)).text() === 'authorized');
        } else {
          try { await fetch(endpoint); throw new Error('redirect escaped'); }
          catch (error) { assert(error instanceof TypeError); }
        }
      `,
        productId: "sandbox.testnet",
        provider,
        authorize: async (url) =>
          grantDestination || new URL(url).hostname === "127.0.0.1",
        timeoutMs: 10_000,
      });
      expect(hits).toEqual(
        grantDestination ? ["allowed", "destination"] : ["allowed"],
      );
    } finally {
      redirect.stop(true);
      target.stop(true);
    }
  }, 20_000);
}

test("script rejection is reported to the CLI", async () => {
  await expect(
    runBrowserScript({
      source: "throw new Error('product failure');",
      productId: "sandbox.testnet",
      provider,
      authorize: async () => false,
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow("product failure");
}, 20_000);

test("a stalled product reports a timeout", async () => {
  await expect(
    runBrowserScript({
      source: "await new Promise(() => {});",
      productId: "sandbox.testnet",
      provider,
      authorize: async () => false,
      timeoutMs: 250,
    }),
  ).rejects.toThrow("Product script timed out");
}, 20_000);

test("authorization errors fail closed before any request reaches the server", async () => {
  const hits: string[] = [];
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(request.url);
      return new Response("unexpected");
    },
  });
  try {
    await expect(
      runBrowserScript({
        source: `const image = new Image(); image.src = ${JSON.stringify(endpoint.url.href)}; await new Promise(() => {});`,
        productId: "sandbox.testnet",
        provider,
        authorize: async () => {
          throw new Error("Permission service unavailable");
        },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Permission service unavailable");
    expect(hits).toEqual([]);
  } finally {
    endpoint.stop(true);
  }
}, 20_000);
