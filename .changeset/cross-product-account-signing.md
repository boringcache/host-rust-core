---
"@parity/truapi": minor
---

`sign_payload`, `create_transaction`, `sign_raw` and the statement-store product proof accept another product's
account when that product's manifest grants the caller `context`, the same grant `create_account_proof` and
`ring_vrf_sign` already honour.
