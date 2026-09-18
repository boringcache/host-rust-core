//! Unified [`NftPurse`] trait: the host-held NFT purses over `pallet-scarcity`.

use crate::versioned::nft_purse::{
    HostNftPurseListError, HostNftPurseListRequest, HostNftPurseListResponse,
    HostNftPurseListSubscribeError, HostNftPurseListSubscribeItem,
    HostNftPurseListSubscribeRequest, HostNftPurseRequestReceiveAddressError,
    HostNftPurseRequestReceiveAddressRequest, HostNftPurseRequestReceiveAddressResponse,
    HostNftPurseTransferError, HostNftPurseTransferItem, HostNftPurseTransferRequest,
};
use crate::{CallContext, CallError, Subscription};
use crate::{wire, wire_trait};

/// NFT purse operations.
///
/// The host keeps one `pallet-scarcity` purse per product plus the wallet's
/// own, each a set of host-derived keys holding one NFT apiece. Custody is
/// context: an item belongs to whichever product's purse holds it, and the
/// host signs from a purse only for that product or for the user in trusted
/// wallet UI. Products never see a purse key's secret, never derive or scan,
/// and never sign a purse transaction themselves. They list their own purse,
/// obtain a fresh empty key to receive an NFT into, and ask the host to move an
/// NFT they hold; the host derives, reads, prompts, signs and watches.
#[wire_trait(id = 19)]
#[crate::async_trait]
pub trait NftPurse: Send + Sync {
    /// List the NFTs in the caller's purse.
    ///
    /// The host asks the user once per product and remembers the answer. The
    /// `collections` filter narrows the response, not the grant. The response
    /// carries chain facts only; products resolve names and artwork themselves
    /// through `chain.*` and the pallet's runtime APIs.
    ///
    /// ```ts
    /// const result = await truapi.nftPurse.list({ collections: [7] });
    /// assert(result.isOk(), "list failed:", result);
    /// for (const item of result.value.items) {
    ///   console.log("held instance", item.instance, "in collection", item.collection);
    /// }
    /// ```
    #[wire(id = 0)]
    async fn list(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseListRequest,
    ) -> Result<HostNftPurseListResponse, CallError<HostNftPurseListError>> {
        Err(CallError::unavailable())
    }

    /// Obtain a fresh, empty purse key that may receive exactly one NFT.
    ///
    /// With no `target` the key is allocated in the caller's own purse,
    /// promptless once `list` was granted. With a `target` product id the key
    /// is allocated in that product's purse, so a minting surface can place an
    /// item straight into another product's collectibles; the host asks the
    /// user once per caller and target. The same `idempotencyKey` always
    /// returns the same address, so a retried request never strands a key.
    /// Minting surfaces pass the address as the mint destination; a game
    /// publishes it so an opponent can transfer to it.
    ///
    /// ```ts
    /// const result = await truapi.nftPurse.requestReceiveAddress({
    ///   idempotencyKey: "match-42-winner",
    ///   target: undefined,
    /// });
    /// assert(result.isOk(), "requestReceiveAddress failed:", result);
    /// console.log("receive into", result.value.address);
    /// ```
    #[wire(id = 1)]
    async fn request_receive_address(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseRequestReceiveAddressRequest,
    ) -> Result<
        HostNftPurseRequestReceiveAddressResponse,
        CallError<HostNftPurseRequestReceiveAddressError>,
    > {
        Err(CallError::unavailable())
    }

    /// Move one NFT the caller's purse holds to another purse key.
    ///
    /// Always shows the user a consent sheet naming the item and destination;
    /// when the destination is a purse key the host derived, the sheet names
    /// that product. On approval the host signs `Scarcity.transfer` with the
    /// holding purse key under the pallet's `AsScarcity` extension (feeless,
    /// mortal), broadcasts it, and verifies ownership at the included block.
    /// The stream ends with `Landed` or `Failed`.
    ///
    /// ```ts
    /// import { lastValueFrom, from } from "rxjs";
    ///
    /// const status = await lastValueFrom(
    ///   from(
    ///     truapi.nftPurse.transfer({
    ///       instance: 34n,
    ///       to: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ///     }),
    ///   ),
    /// );
    /// console.log("transfer status:", status);
    /// ```
    #[wire(id = 2)]
    async fn transfer(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseTransferRequest,
    ) -> Subscription<HostNftPurseTransferItem, CallError<HostNftPurseTransferError>> {
        Subscription::interrupted(CallError::unavailable())
    }

    /// Follow the NFTs in the caller's purse.
    ///
    /// Emits the whole purse on subscribe and again after every change the
    /// host observes: an arrival, a move in or out, a burn, or a
    /// collection-owner force move. Same grant as `list`.
    ///
    /// ```ts
    /// import { firstValueFrom, from } from "rxjs";
    ///
    /// const first = await firstValueFrom(
    ///   from(truapi.nftPurse.listSubscribe({ collections: undefined })),
    /// );
    /// console.log("held items:", first.items.length);
    /// ```
    #[wire(id = 3)]
    async fn list_subscribe(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseListSubscribeRequest,
    ) -> Subscription<HostNftPurseListSubscribeItem, CallError<HostNftPurseListSubscribeError>>
    {
        Subscription::interrupted(CallError::unavailable())
    }
}
