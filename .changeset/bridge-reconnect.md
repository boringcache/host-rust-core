---
"@parity/truapi": minor
---

The SDK connects directly to the WebSocket endpoint published by iOS, Android,
and the development CLI. After a disconnect, the next API call reconnects without
reloading the page. Products must update the SDK to use this endpoint bootstrap.
