---
"@parity/truapi": minor
---

The localhost bridge a native host injects now survives its socket dying. When the connection drops it
retires the port it published, reports the close on `onmessageerror` as before, and once the SDK has let go
of `window.__HOST_API_PORT__` publishes a fresh one with bounded backoff, so the product rebuilds its client
against a new core-side runtime instead of waiting forever for a port nobody was going to send. It also
defines `window.__pauseConnections__` and `window.__resumeConnections__`, which iOS and Android already call
on app lifecycle, so a foregrounded product redials at once rather than waiting for a suspended content
process to notice its socket is gone. A product left open across an app background therefore keeps working
when the app returns, with no page reload.

The bridge also releases a connection whose peer vanished. A socket that dies without a closing handshake
leaves its outbound pump parked on a channel nobody will send on, which holds the connection task, its slot
against the 32-connection cap and its socket open, so a product that reconnects once per app background would
eventually be refused.

One JavaScript source now backs every host: `truapi_server::bootstrap::script`, exported to native hosts as
`localhostBridgeBootstrapScript(port:token:webRtcAllowed:)`. `LocalhostBridgeBootstrap.script` on iOS and
Android keeps its signature and renders from it, and `truapi-host`'s development bridge serves the same
script, so it reconnects too.
