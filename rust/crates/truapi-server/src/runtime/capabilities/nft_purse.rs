//! Product-facing `NftPurse` capability adapter.
//!
//! Answered by the signing host's purse engine once it lands; every host
//! reports the service unsupported until then.

use tracing::instrument;
use truapi::api::NftPurse;
use truapi::versioned::nft_purse::{
    HostNftPurseListError, HostNftPurseListRequest, HostNftPurseListResponse,
    HostNftPurseListSubscribeError, HostNftPurseListSubscribeItem,
    HostNftPurseListSubscribeRequest, HostNftPurseRequestReceiveAddressError,
    HostNftPurseRequestReceiveAddressRequest, HostNftPurseRequestReceiveAddressResponse,
    HostNftPurseTransferError, HostNftPurseTransferItem, HostNftPurseTransferRequest,
};
use truapi::{CallContext, CallError, Subscription};

use crate::runtime::ProductRuntimeHost;

#[truapi::async_trait]
impl NftPurse for ProductRuntimeHost {
    #[instrument(skip_all, fields(runtime.method = "nft_purse.list"))]
    async fn list(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseListRequest,
    ) -> Result<HostNftPurseListResponse, CallError<HostNftPurseListError>> {
        Err(CallError::Unsupported)
    }

    #[instrument(skip_all, fields(runtime.method = "nft_purse.request_receive_address"))]
    async fn request_receive_address(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseRequestReceiveAddressRequest,
    ) -> Result<
        HostNftPurseRequestReceiveAddressResponse,
        CallError<HostNftPurseRequestReceiveAddressError>,
    > {
        Err(CallError::Unsupported)
    }

    #[instrument(skip_all, fields(runtime.method = "nft_purse.transfer"))]
    async fn transfer(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseTransferRequest,
    ) -> Subscription<HostNftPurseTransferItem, CallError<HostNftPurseTransferError>> {
        Subscription::interrupted(CallError::Unsupported)
    }

    #[instrument(skip_all, fields(runtime.method = "nft_purse.list_subscribe"))]
    async fn list_subscribe(
        &self,
        _cx: &CallContext,
        _request: HostNftPurseListSubscribeRequest,
    ) -> Subscription<HostNftPurseListSubscribeItem, CallError<HostNftPurseListSubscribeError>>
    {
        Subscription::interrupted(CallError::Unsupported)
    }
}
