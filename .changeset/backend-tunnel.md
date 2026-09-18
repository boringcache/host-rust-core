---
"@parity/truapi": minor
---

A `Backend` trait carries product requests to a backend the host holds a credential for. The product names a
backend identifier plus a method, path, query and body; the host resolves it to a base URL and its own
credential, performs the call, and returns the status, an allowlisted set of headers and the body. The core
screens the request so it cannot address anything outside the backend's origin, and holds no credential itself.
Hosts serve it through the optional `BackendHost` capability; one that registers no backends answers
`Unsupported`.
