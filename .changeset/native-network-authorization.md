---
"@parity/truapi": minor
"@parity/truapi-host": minor
---

Preserve one-use grants with explicit host permission decisions. Normalize remote domains, match legacy wildcard coverage and navigation permissions, and keep a shared blessed-domain list. Add internal `authorize_remote_permission` and `authorize_device_permission` methods for containers, reusing the public request types while consuming one-use grants. Keep these methods out of the public SDK and API documentation. Present per-action confirmations without misleading persistent-permission choices.
