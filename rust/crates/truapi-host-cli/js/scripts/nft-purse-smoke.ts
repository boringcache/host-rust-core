/// <reference path="../runner.ts" />
// NFT purse smoke: exercises every `nftPurse` method a product can call without
// holding an NFT. Listing an empty purse succeeds, receive keys are stable per
// idempotency key and distinct across keys, a transfer of an instance the purse
// does not hold ends the stream with `Failed { NotFound }`, and a numeric
// target purse is refused as `UnknownTarget`. Landing a real transfer needs an
// NFT minted into a receive address first, which no CLI command does yet.
export {};

type TransferStatus = Awaited<ReturnType<typeof collectTransfer>>[number];

/** Drain a transfer stream into its items; the stream ends on its own. */
function collectTransfer(instance: bigint, to: `0x${string}`) {
  return new Promise<
    Array<
      | { tag: "Started"; value?: undefined }
      | { tag: "InBlock"; value: { block: string } }
      | { tag: "Landed"; value?: undefined }
      | { tag: "Failed"; value: { error: { tag: string; value?: unknown } } }
    >
  >((resolve, reject) => {
    const items: TransferStatus[] = [];
    truapi.nftPurse.transfer({ request: { instance, to } }).subscribe({
      next: (item) => items.push(item),
      error: (error) => reject(new Error(`transfer interrupted: ${JSON.stringify(error)}`)),
      complete: () => resolve(items),
    });
  });
}

const listed = await truapi.nftPurse.list({ collections: undefined });
assert(listed.isOk(), "list failed:", listed);
console.log(`LIST ${listed.value.items.length} item(s) in ${host.productId}'s purse`);

const first = await truapi.nftPurse.requestReceiveAddress({
  idempotencyKey: "nft-purse-smoke",
  target: undefined,
});
assert(first.isOk(), "requestReceiveAddress failed:", first);
const again = await truapi.nftPurse.requestReceiveAddress({
  idempotencyKey: "nft-purse-smoke",
  target: undefined,
});
assert(again.isOk(), "repeated requestReceiveAddress failed:", again);
assert(
  again.value.address === first.value.address,
  "the same idempotency key must return the same receive key",
  first.value.address,
  again.value.address,
);
const other = await truapi.nftPurse.requestReceiveAddress({
  idempotencyKey: `nft-purse-smoke-${Date.now()}`,
  target: undefined,
});
assert(other.isOk(), "second requestReceiveAddress failed:", other);
assert(
  other.value.address !== first.value.address,
  "a new idempotency key must allocate a fresh receive key",
);
console.log(`RECEIVE ${first.value.address}`);

const statuses = await collectTransfer(2n ** 63n, other.value.address);
const terminal = statuses.at(-1);
assert(
  terminal?.tag === "Failed" && terminal.value.error.tag === "NotFound",
  "moving an instance the purse does not hold must end with Failed { NotFound }:",
  statuses,
);
console.log("TRANSFER unheld instance -> NotFound");

const numeric = await truapi.nftPurse.requestReceiveAddress({
  idempotencyKey: "nft-purse-smoke-numeric",
  target: "12345",
});
assert(
  numeric.isErr() &&
    numeric.error.tag === "Domain" &&
    numeric.error.value.value.tag === "UnknownTarget",
  "a numeric target purse must be refused as UnknownTarget:",
  numeric,
);
console.log("TARGET numeric -> UnknownTarget");

console.log("NFT_PURSE_SMOKE_OK");
