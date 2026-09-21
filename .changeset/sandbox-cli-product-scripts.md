---
"@parity/truapi": minor
---

Run CLI product scripts in Chromium using the same shared browser container and Rust permission checks as the development bootstrap tag. Dev keeps its existing app URL, assets and hot reload. Public SDK calls and private permission requests share one product execution.

Scripts use Chromium installed with `truapi-host install-browser`. Host filesystem, Node or Bun access requires `--trusted-script`. Release archives include the shared browser assets, driver and script compiler. The container checks patched browser APIs; it does not provide complete browser network isolation.
