---
"@parity/truapi": minor
---

`nftPurse` is the host-held NFT purse over `pallet-scarcity`: one purse of host-derived keys per
product plus the wallet's own, one NFT per key. A product lists its own purse (`list`,
`listSubscribe`), asks for a fresh empty key to receive one NFT into (`requestReceiveAddress`,
idempotent per caller key, optionally into another product's purse), and asks the host to move an
item it holds (`transfer`, a stream ending in `Landed` or `Failed`). The host derives, reads, prompts,
signs and watches; products never see a purse secret. Listing is granted once per product; every
transfer shows a consent sheet.
