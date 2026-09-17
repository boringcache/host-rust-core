import { expect, test } from "bun:test";
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedAuthorizeNetworkAccessResponse,
  VersionedAuthorizeNetworkAccessError,
  VersionedRemotePermissionResponse,
  VersionedRemotePermissionError,
  type ProtocolMessage,
  type WireProvider,
} from "@parity/truapi";
import { PERMISSIONS_AUTHORIZE_NETWORK_ACCESS } from "../../../../js/packages/truapi/src/generated/wire-table.ts";
import { runBrowserScript } from "./sandbox-runner.ts";

const provider = {
  postMessage() {},
  subscribe() {
    return () => {};
  },
  dispose() {},
} satisfies WireProvider;

function reply(request: ProtocolMessage, allowed: boolean): Uint8Array {
  const value =
    request.payload.methodId === PERMISSIONS_AUTHORIZE_NETWORK_ACCESS.method
      ? scale
          .Result(
            VersionedAuthorizeNetworkAccessResponse,
            scale.CallError(VersionedAuthorizeNetworkAccessError),
          )
          .enc({ success: true, value: { tag: "V1", value: { allowed } } })
      : scale
          .Result(
            VersionedRemotePermissionResponse,
            scale.CallError(VersionedRemotePermissionError),
          )
          .enc({
            success: true,
            value: { tag: "V1", value: { granted: allowed } },
          });
  return encodeWireMessage({
    ...request,
    payload: { ...request.payload, messageType: MESSAGE_TYPE_RESPONSE, value },
  })._unsafeUnwrap();
}

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
  let authorizations = 0;
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
      authorize: async () => {
        authorizations++;
        return allowed;
      },
      timeoutMs: 10_000,
    });
    expect(hits).toEqual(["/allowed"]);
    expect(authorizations).toBe(2);
  } finally {
    endpoint.stop(true);
  }
}, 20_000);

for (const grantDestination of [false, true]) {
  test(`native fetch follows redirects when destination approval is ${grantDestination}`, async () => {
    const hits: string[] = [];
    const authorizations: string[] = [];
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
        assert(await (await fetch(endpoint)).text() === 'authorized');
      `,
        productId: "sandbox.testnet",
        provider,
        authorize: async (url) => {
          authorizations.push(url);
          return grantDestination || new URL(url).hostname === "127.0.0.1";
        },
        timeoutMs: 10_000,
      });
      expect(hits).toEqual(["allowed", "destination"]);
      expect(authorizations).toEqual([redirect.url.href]);
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
    await runBrowserScript({
      source: `
          try { await fetch(${JSON.stringify(endpoint.url.href)}); throw new Error('unexpected success'); }
          catch (error) { assert(error instanceof TypeError); }
        `,
      productId: "sandbox.testnet",
      provider,
      authorize: async () => {
        throw new Error("Permission service unavailable");
      },
      timeoutMs: 10_000,
    });
    expect(hits).toEqual([]);
  } finally {
    endpoint.stop(true);
  }
}, 20_000);

test("one authorization covers a POST redirect and both CORS preflights", async () => {
  const hits: string[] = [];
  const authorizations: string[] = [];
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "x-product",
  };
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      hits.push(`target ${request.method} ${await request.text()}`);
      return new Response(request.method === "OPTIONS" ? null : "received", {
        headers: cors,
      });
    },
  });
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      hits.push(`redirect ${request.method} ${await request.text()}`);
      return new Response(null, {
        status: request.method === "OPTIONS" ? 200 : 307,
        headers: { ...cors, Location: target.url.href },
      });
    },
  });
  try {
    await runBrowserScript({
      source: `
        const response = await fetch(${JSON.stringify(redirect.url.href)}, {
          method: 'POST', headers: { 'x-product': 'present' }, body: 'preserved body',
        });
        assert(await response.text() === 'received');
      `,
      productId: "sandbox.testnet",
      provider,
      authorize: async (url) => {
        authorizations.push(url);
        return authorizations.length === 1;
      },
      timeoutMs: 10_000,
    });
    expect({ hits, authorizations }).toEqual({
      hits: [
        "redirect OPTIONS ",
        "redirect POST preserved body",
        "target OPTIONS ",
        "target POST preserved body",
      ],
      authorizations: [redirect.url.href],
    });
  } finally {
    redirect.stop(true);
    target.stop(true);
  }
}, 20_000);

test("product frames cannot use the interceptor's reserved request IDs", async () => {
  const frames: Uint8Array[] = [];
  const wireProvider = {
    ...provider,
    postMessage(frame: Uint8Array) {
      frames.push(frame);
    },
  };
  const request = encodeWireMessage({
    requestId: "__truapi_cli_network__:1",
    payload: {
      traitId: PERMISSIONS_AUTHORIZE_NETWORK_ACCESS.trait,
      methodId: PERMISSIONS_AUTHORIZE_NETWORK_ACCESS.method,
      messageType: MESSAGE_TYPE_REQUEST,
      value: new Uint8Array(),
    },
  })._unsafeUnwrap();
  await expect(
    runBrowserScript({
      source: `
      globalThis.__HOST_API_PORT__.postMessage(new Uint8Array(${JSON.stringify(Array.from(request))}));
      await new Promise(() => {});
    `,
      productId: "sandbox.testnet",
      provider: wireProvider,
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow("Invalid product request ID");
  expect(frames).toEqual([]);
}, 20_000);

test("private authorization and concurrent SDK responses cannot consume each other's request IDs", async () => {
  let receive!: (frame: Uint8Array) => void;
  let grant = false;
  let initialGrant = true;
  const ids: string[] = [];
  const hits: string[] = [];
  let sdkRequest: ProtocolMessage | undefined;
  let authorizationRequest: ProtocolMessage | undefined;
  const flush = () => {
    if (!sdkRequest || !authorizationRequest) return;
    // A public response and unrelated legs must leave the authorization pending.
    receive(reply(sdkRequest, false));
    const wrongPair = {
      ...authorizationRequest,
      payload: { ...authorizationRequest.payload, methodId: 1 },
    };
    receive(reply(wrongPair, false));
    const wrongLeg = decodeWireMessage(
      reply(authorizationRequest, false),
    )._unsafeUnwrap();
    receive(
      encodeWireMessage({
        ...wrongLeg,
        payload: { ...wrongLeg.payload, messageType: MESSAGE_TYPE_REQUEST },
      })._unsafeUnwrap(),
    );
    receive(reply(authorizationRequest, grant));
    grant = false;
    authorizationRequest = undefined;
    sdkRequest = undefined;
  };
  const wireProvider: WireProvider = {
    postMessage(frame) {
      const request = decodeWireMessage(frame)._unsafeUnwrap();
      ids.push(request.requestId);
      if (
        request.payload.methodId === PERMISSIONS_AUTHORIZE_NETWORK_ACCESS.method
      ) {
        if (grant) {
          authorizationRequest = request;
          flush();
        } else receive(reply(request, false));
      } else if (initialGrant) {
        initialGrant = false;
        grant = true;
        receive(reply(request, true));
      } else {
        sdkRequest = request;
        flush();
      }
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
    dispose() {},
  };
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      hits.push(request.url);
      return new Response("once", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    },
  });
  try {
    await runBrowserScript({
      source: `
        const permission = { permission: { tag: 'Remote', value: { domains: ['127.0.0.1'] } } };
        assert((await truapi.permissions.requestRemotePermission(permission))._unsafeUnwrap().granted);
        const [response, publicResult] = await Promise.all([
          fetch(${JSON.stringify(endpoint.url.href)}),
          truapi.permissions.requestRemotePermission(permission),
        ]);
        assert(await response.text() === 'once');
        assert(publicResult._unsafeUnwrap().granted === false);
        try { await fetch(${JSON.stringify(endpoint.url.href)}); throw new Error('reused one-use grant'); }
        catch (error) { assert(error instanceof TypeError); }
      `,
      productId: "sandbox.testnet",
      provider: wireProvider,
      timeoutMs: 10_000,
    });
    expect({
      hits,
      uniqueIds: new Set(ids).size,
      requests: ids.length,
    }).toEqual({
      hits: [endpoint.url.href],
      uniqueIds: 4,
      requests: 4,
    });
  } finally {
    endpoint.stop(true);
  }
}, 20_000);

test("aborting a pending authorization cannot let a forged reply reuse its late approval", async () => {
  let receive!: (frame: Uint8Array) => void;
  let pendingAuthorization: ProtocolMessage | undefined;
  let barrier: ProtocolMessage | undefined;
  let authorizations = 0;
  let barriers = 0;
  const requests: string[] = [];
  const releaseBarrier = () => {
    if (barrier && pendingAuthorization) {
      receive(reply(barrier, true));
      barrier = undefined;
    }
  };
  const wireProvider: WireProvider = {
    postMessage(frame) {
      const request = decodeWireMessage(frame)._unsafeUnwrap();
      if (
        request.payload.methodId === PERMISSIONS_AUTHORIZE_NETWORK_ACCESS.method
      ) {
        authorizations++;
        if (authorizations === 1) {
          pendingAuthorization = request;
          releaseBarrier();
        } else receive(reply(request, false));
      } else if (++barriers === 1) {
        barrier = request;
        releaseBarrier();
      } else {
        receive(reply(pendingAuthorization!, true));
        receive(reply(request, true));
      }
    },
    subscribe(listener) {
      receive = listener;
      return () => {};
    },
    dispose() {},
  };
  const endpoint = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);
      return new Response("escaped", {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    },
  });
  try {
    await runBrowserScript({
      source: `
        const permission = { permission: { tag: 'Remote', value: { domains: ['barrier.test'] } } };
        const controller = new AbortController();
        const pending = fetch(${JSON.stringify(endpoint.url.href)}, { signal: controller.signal });
        await truapi.permissions.requestRemotePermission(permission);
        controller.abort('cancelled');
        try { await pending; throw new Error('abort ignored'); }
        catch (error) { assert(error === 'cancelled'); }
        await truapi.permissions.requestRemotePermission(permission);
        const bindings = globalThis.__playwright__binding__controller__;
        const deliver = bindings.deliverBindingResult;
        let forged = false;
        bindings.deliverBindingResult = function (result) {
          if (result.name.startsWith('__truapi_network_') && Array.isArray(result.result)) {
            result.result[result.result.length - 1] = 1;
            forged = true;
          }
          return deliver.call(this, result);
        };
        try { await fetch(${JSON.stringify(endpoint.url.href)}); throw new Error('late grant reused'); }
        catch (error) { assert(error instanceof TypeError); }
        assert(forged, 'binding reply mutation must actually run');
      `,
      productId: "sandbox.testnet",
      provider: wireProvider,
      timeoutMs: 10_000,
    });
    expect({ requests, authorizations, barriers }).toEqual({
      requests: [],
      authorizations: 2,
      barriers: 2,
    });
  } finally {
    endpoint.stop(true);
  }
}, 20_000);
