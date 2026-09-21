---
"@parity/truapi": minor
---

A `Backend` trait carries product requests to a backend the host holds a credential for. The product names a
backend identifier plus a method, path, query and body; the host resolves it to a base URL and its own
credential, performs the call, and returns the status, an allowlisted set of headers and the body. A request
may also carry `bearer`, a credential the product holds for a backend that answers per person: the host sends
it as `Authorization: Bearer` and its own as `X-Polkadot-Host-Authorization`, so the two never displace each
other, and the core screens it to RFC 7235 `token68` so it cannot fold a second header into the call. The core
screens the request so it cannot address anything outside the backend's origin, and holds no credential itself.
`Backend::list` reports the identifiers a host serves the calling product, so a product can check before it
depends on one. Hosts serve both through the optional `BackendHost` capability; a host with no tunnel answers
`Unsupported`, and one that has a tunnel but not the named backend answers `UnknownBackend`.
