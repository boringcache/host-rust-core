---
"@parity/truapi": minor
---

Products can reconnect to the host after the localhost bridge socket disconnects,
without reloading the page. A shared bootstrap for iOS, Android, and the development
CLI publishes a replacement port with bounded retries and supports app pause/resume.
It preserves existing host ports and connections that are still opening.
