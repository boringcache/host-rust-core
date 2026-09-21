---
"@parity/truapi": minor
---

The SDK connects directly to the WebSocket endpoint published by iOS, Android,
and the development CLI. After a disconnect, the next API call reconnects without
reloading the page. Products using older SDKs remain supported through a minimal
port adapter, but must reload the page after a disconnect.
