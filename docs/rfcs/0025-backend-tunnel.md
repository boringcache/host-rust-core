---
title: "Deployer backend tunnel"
owner: "@BigTava"
authors: ["@BigTava", "@filvecchiato"]
status: draft
---

# RFC-0025 — Deployer backend tunnel

## Summary

A product names a backend and a request against it; the host performs that request with a credential the product never sees and returns the answer. A new `Backend` trait carries it, served by a new optional host capability. The core screens the request, forwards it, and holds no secret of its own.

## Motivation

A product cannot hold a server-side API key. It runs on the user's device, so anything it holds is readable there — [Meld](https://docs.meld.io/docs/meld-api/getting-started) says so directly: "Always call Meld from your backend. Direct calls from a browser or mobile app expose your API key."

So the key lives in a backend the deployer runs, and the question is how a product reaches it. Answering that with a caller identity — a signature the host attaches to the product's own outbound request — answers a different question. It tells a backend *who* is calling, but a deployer's backend does not need to identify the user; it needs to know the call came through a host it trusts, so it can decide whether to spend its own quota on it.

There are two credentials, belonging to different parties: the **third-party key** lives in the deployer's backend, the only place it can; the **backend's own credential** lives in the host, which already ships secrets. The product holds neither and needs to hold neither.

## Approach

```
product  ──  backend.request { backend, method, path, query, body }
   │
core     ──  screens the request; resolves nothing, holds nothing
   │
host     ──  backend id → base URL + credential; performs the HTTPS call
   │
backend  ──  holds the third-party key
```

The product supplies an opaque identifier and a request relative to it. It never supplies an origin: scheme, host, port and userinfo have no field to travel in. Which base URL the identifier resolves to, and what authenticates the host to it, is host configuration — not protocol, not manifest, and not readable by a product.

The identifier resolves per call rather than at startup, so a host can add a backend or refresh a credential without the core knowing. An identifier a host does not serve is an error, not a missing capability.

A URL in the product's hands would be a deployment detail in every product's source and every debugger frame, and a value the product could vary. An identifier is neither.

### What the core screens

Moving outbound HTTP into the protocol is what a proxy design does, and the usual objection is that a proxy needs SSRF rules, redirect handling and size bounds.

**It needs no SSRF rules, because the product cannot express an origin.** There is nothing to smuggle. That holds only while the path and query cannot reconstitute one:

| Field | Rule |
| --- | --- |
| `backend` | non-empty, ≤64 bytes, `[a-z0-9-]`, no leading or trailing hyphen |
| `path` | absolute; no `//` prefix; no empty, `.` or `..` segments; no `?`, `#`, `\`, `%`, space, control or non-ASCII byte; ≤2048 bytes |
| `query` | ≤64 items, ≤4096 bytes total; names `[A-Za-z0-9_.-]`; values may hold any URL syntax, because the host encodes them |
| `body` | present only on `POST`/`PUT`/`PATCH`; `Json` must be UTF-8; ≤1 MiB |

`%` is banned rather than validated: `%2e%2e%2f` and `%2f` pass a check for the literal characters and become traversal once a URL parser normalizes them. Variable data belongs in the query.

Rules reject rather than normalize, so no normalizer has to stay in step across the boundary.

### What the host owns

The base URL, TLS, DNS, timeouts and the credential — plus four things the core cannot check:

1. **Set the path on the parsed base; never concatenate.** Refuse a base carrying a query or fragment: appended to `https://api.example.com/v1?key=abc`, a path lands inside the query. This is the one way a screened request can still reach somewhere unintended.
2. **Do not follow redirects.** Return the `3xx`.
3. **Cap the response** rather than truncating it.
4. **Return only the allowlisted headers.**

The core re-screens the response, so a host that forgets cannot reach a product through this call.

### The body carries its content type

`Json` and `Form` rather than bytes plus a content-type string. A free-form content type is a header the product writes; bytes with no content type is a header each host guesses differently — `fetch` labels a string body `text/plain`, the native clients label nothing, and a backend expecting JSON refuses two of three. Pinning the type to the variant is what makes one call behave the same everywhere.

### What comes back

Status, body, and a fixed allowlist: `content-type`, `retry-after`, `link`, and the `x-ratelimit-*` trio. Enough to parse the answer and to honour a backend asking the caller to slow down.

Everything else is dropped, so what a backend could achieve with a header is not a question that needs answering. `set-cookie` would be ambient authority in the product's realm; `location` would name the origin the tunnel keeps to itself.

### The calling product

The host forwards the connection's product id as `X-Polkadot-Product`, overwriting any header of that name, so a backend can meter or refuse per product. It comes from the connection the host opened, not from anything the product sent. It is host-attested, not cryptographic: a modified host can claim any product id.

## Trade-offs

- **Any product the host runs can call any backend in its registry.** There is no consent prompt and no per-product allowlist in the core. What bounds it is that the registry is first-party — the host ships it, so which services are reachable at all is the host vendor's decision. Beyond that it is the backend's job: **a backend registered on a host that runs more than one product must authorize on the forwarded product id**, and should rate-limit on it, since nothing in the core stops a product from looping.
- A registry entry can pin the product ids it serves. That is host configuration at no protocol cost, and it is the difference between the paragraph above being policy and being hope. Hosts should ship it from the start.
- **Browser-based hosts cannot hold a credential secretly** — anything dotli or the web host ships is readable in devtools, which is this RFC's opening argument one layer up. They register no backends and answer `Unsupported`.
- **Outbound HTTP now exists in the protocol**, which [RFC-0002](0002-permission-model.md) assigned to the sandbox. The screening rules pay for that, and the scope is narrow: one method, no streaming, no multipart, no cookies, 1 MiB each way.
- **No `Link`-header pagination and no auth challenges are reachable.** Both follow from the header allowlist.
- **On a browser host every host-side failure collapses to one variant**, since a JS host can only reject with a string. Native hosts and the CLI return them typed.
- **Adding a backend needs a host release.** That is the cost of the registry being the trust boundary.
- **Rejected: a caller identity the host attaches to the product's own request.** It answers "which user" when the deployer asks "which host", it needs the host to intercept an outbound request — which Android's `shouldInterceptRequest` cannot do for a body and dotli cannot do at all — and it leaves the product's own network stack carrying the call, with CORS and interception differing per platform.
- **Rejected: a core-side rate limit.** The backend holds the quota and is the only party that knows its own limits.

## Open questions

1. **Is the response-header allowlist the right set?** It is the smallest one that lets a product parse an answer and back off, but widening it later is a wire change.
2. **How is a registry provisioned and rotated across hosts?** Today each host ships its own, so a credential rotation is a release per host.
3. **Should pinning allowed product ids be protocol rather than host configuration?** Protocol would let the core enforce it; host-side keeps the core free of a policy it cannot verify.
