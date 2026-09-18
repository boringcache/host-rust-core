---
"@parity/truapi-host": minor
---

Take the wire debugger's dial from the embedding host instead of `localStorage`.

`createWebWorkerPairingHostRuntime` accepts a `debugger` option; a dev build may carry a default in
`VITE_TRUAPI_DEBUGGER_URL`. The host's own value wins, and `null` or `""` refuses the dial outright. The dial is
resolved once at construction and cannot be changed from the page afterwards, so whether a session is observed is a
property of the build and the host rather than of anything typed into a console later.

While a dial is live the host shows a small dev-only badge naming the endpoint, suppressible with
`debuggerIndicator: false` for a host that renders its own.

**Breaking for anyone enabling the debugger today:** the `truapi:debugger` `localStorage` key is no longer read, and
setting it has no effect. Pass the `debugger` option, or build with `VITE_TRUAPI_DEBUGGER_URL`.
