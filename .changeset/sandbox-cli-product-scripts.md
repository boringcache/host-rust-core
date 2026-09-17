---
"@parity/truapi": patch
---

Run CLI product scripts in a sandboxed browser by default, authorize each fetch's initial URL through Rust, and package the matching browser driver and script compiler. Share one authorization across CORS preflights and native redirects. Add explicit browser installation and keep host diagnostics available through `TRUAPI_SCRIPT_MODE=trusted`.
