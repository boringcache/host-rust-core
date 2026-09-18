//! Product-facing `NftPurse` capability adapter.
//!
//! Every method resolves the calling product from the runtime, never from
//! the request, checks the persisted grant, and delegates to the account
//! authority, which alone reaches the purse keys: locally on a signing host,
//! through the paired signing host on a pairing host. The transfer sheet is
//! shown where the keys live, so this layer raises only the access grants.
//! Hosts whose authority reaches no purses answer `Unsupported` before any
//! session is consulted.

use core::time::Duration;
use std::sync::Arc;

use tracing::instrument;
use truapi::api::NftPurse;
use truapi::versioned::nft_purse::{
    HostNftPurseListError, HostNftPurseListRequest, HostNftPurseListResponse,
    HostNftPurseListSubscribeError, HostNftPurseListSubscribeItem,
    HostNftPurseListSubscribeRequest, HostNftPurseRequestReceiveAddressError,
    HostNftPurseRequestReceiveAddressRequest, HostNftPurseRequestReceiveAddressResponse,
    HostNftPurseTransferError, HostNftPurseTransferItem, HostNftPurseTransferRequest,
};
use truapi::{CallContext, CallError, Subscription, v01};
use truapi_platform::{
    NftPurseAccessReview, NftPurseReceiveForReview, PermissionAuthorizationRequest,
    PermissionAuthorizationStatus, Platform, UserConfirmationReview,
};

use crate::host_logic::permissions::PermissionsService;
use crate::runtime::authority::AuthoritySession;
use crate::runtime::nft_purse::NftPurseAuthorityError;
use crate::runtime::{AccountAccessAuthorizationError, AuthorityError, ProductRuntimeHost};

/// Interval between purse re-reads while a `list_subscribe` stream is open.
/// The chain is not observed reactively yet; this is the pull that keeps a
/// live view live.
const LIST_POLL_INTERVAL: Duration = Duration::from_secs(12);

/// Map an authority failure onto the service's error, with `wrap` naming the
/// method's versioned envelope.
fn nft_purse_call_error<E>(
    err: NftPurseAuthorityError,
    wrap: impl Fn(v01::NftPurseError) -> E,
) -> CallError<E> {
    let domain = match err {
        NftPurseAuthorityError::Authority(AuthorityError::Disconnected) => {
            v01::NftPurseError::NotConnected
        }
        NftPurseAuthorityError::Authority(AuthorityError::Rejected) => v01::NftPurseError::Rejected,
        NftPurseAuthorityError::Authority(AuthorityError::NotSupported { .. }) => {
            return CallError::Unsupported;
        }
        NftPurseAuthorityError::Authority(other) => v01::NftPurseError::Unknown {
            reason: other.to_string(),
        },
        NftPurseAuthorityError::Service(error) => error,
    };
    CallError::Domain(wrap(domain))
}

/// Persist a yes/no answer the way every product-scoped grant is stored.
async fn persist_grant(
    platform: &dyn Platform,
    product_id: &str,
    request: PermissionAuthorizationRequest,
    review: UserConfirmationReview,
) -> Result<PermissionAuthorizationStatus, AccountAccessAuthorizationError> {
    let service = PermissionsService::new(platform, platform, product_id);
    let cached = service
        .authorization_status(&request)
        .await
        .map_err(AccountAccessAuthorizationError::PermissionStorage)?;
    if cached != PermissionAuthorizationStatus::NotDetermined {
        return Ok(cached);
    }
    let confirmed = platform
        .confirm_user_action(review)
        .await
        .map_err(AccountAccessAuthorizationError::Confirmation)?;
    let status = if confirmed {
        PermissionAuthorizationStatus::Authorized
    } else {
        PermissionAuthorizationStatus::Denied
    };
    service
        .set_authorization_status(&request, status)
        .await
        .map_err(AccountAccessAuthorizationError::PermissionStorage)?;
    Ok(status)
}

/// Once per product: may it list its own purse and allocate keys in it?
async fn access_authorization(
    platform: &dyn Platform,
    product_id: &str,
    collections: Option<Vec<u32>>,
) -> Result<PermissionAuthorizationStatus, AccountAccessAuthorizationError> {
    persist_grant(
        platform,
        product_id,
        PermissionAuthorizationRequest::NftPurseAccess,
        UserConfirmationReview::NftPurseAccess(NftPurseAccessReview {
            product_id: product_id.to_string(),
            collections,
        }),
    )
    .await
}

/// Once per caller and target: may `product_id` allocate receive keys in
/// `target_product_id`'s purse?
async fn receive_for_authorization(
    platform: &dyn Platform,
    product_id: &str,
    target_product_id: &str,
) -> Result<PermissionAuthorizationStatus, AccountAccessAuthorizationError> {
    persist_grant(
        platform,
        product_id,
        PermissionAuthorizationRequest::NftPurseReceiveFor {
            target_product_id: target_product_id.to_string(),
        },
        UserConfirmationReview::NftPurseReceiveFor(NftPurseReceiveForReview {
            product_id: product_id.to_string(),
            target_product_id: target_product_id.to_string(),
        }),
    )
    .await
}

impl ProductRuntimeHost {
    /// The active authority session, or `Unsupported` on a host without
    /// purses and the service's `NotConnected` on one without a session.
    fn nft_purse_session<E>(
        &self,
        wrap: impl Fn(v01::NftPurseError) -> E,
    ) -> Result<AuthoritySession, CallError<E>> {
        if !self.authority.supports_nft_purse() {
            return Err(CallError::Unsupported);
        }
        self.authority
            .current_session()
            .ok_or_else(|| CallError::Domain(wrap(v01::NftPurseError::NotConnected)))
    }

    /// Resolve a grant outcome into the service's error space.
    fn nft_purse_grant<E>(
        outcome: Result<PermissionAuthorizationStatus, AccountAccessAuthorizationError>,
        wrap: impl Fn(v01::NftPurseError) -> E,
    ) -> Result<(), CallError<E>> {
        match outcome {
            Ok(PermissionAuthorizationStatus::Authorized) => Ok(()),
            Ok(_) => Err(CallError::Domain(wrap(v01::NftPurseError::Rejected))),
            Err(err) => Err(CallError::Domain(wrap(v01::NftPurseError::Unknown {
                reason: err.to_string(),
            }))),
        }
    }

    /// The pre-stream checks every subscription method runs: a purse-capable
    /// authority, a session, and the access grant.
    async fn nft_purse_granted_session<E>(
        &self,
        collections: Option<Vec<u32>>,
        wrap: impl Fn(v01::NftPurseError) -> E + Copy,
    ) -> Result<(AuthoritySession, String), CallError<E>> {
        let session = self.nft_purse_session(wrap)?;
        let product_id = self.product_id();
        Self::nft_purse_grant(
            access_authorization(self.platform.as_ref(), &product_id, collections).await,
            wrap,
        )?;
        Ok((session, product_id))
    }
}

#[truapi::async_trait]
impl NftPurse for ProductRuntimeHost {
    #[instrument(skip_all, fields(runtime.method = "nft_purse.list"))]
    async fn list(
        &self,
        cx: &CallContext,
        request: HostNftPurseListRequest,
    ) -> Result<HostNftPurseListResponse, CallError<HostNftPurseListError>> {
        let HostNftPurseListRequest::V1(v01::HostNftPurseListRequest { collections }) = request;
        let wrap = HostNftPurseListError::V1;
        let (session, product_id) = self
            .nft_purse_granted_session(collections.clone(), wrap)
            .await?;
        let items = self
            .authority
            .nft_purse_list(cx, &session, product_id, collections)
            .await
            .map_err(|err| nft_purse_call_error(err, wrap))?;
        Ok(HostNftPurseListResponse::V1(
            v01::HostNftPurseListResponse { items },
        ))
    }

    #[instrument(skip_all, fields(runtime.method = "nft_purse.request_receive_address"))]
    async fn request_receive_address(
        &self,
        cx: &CallContext,
        request: HostNftPurseRequestReceiveAddressRequest,
    ) -> Result<
        HostNftPurseRequestReceiveAddressResponse,
        CallError<HostNftPurseRequestReceiveAddressError>,
    > {
        let HostNftPurseRequestReceiveAddressRequest::V1(
            v01::HostNftPurseRequestReceiveAddressRequest {
                idempotency_key,
                target,
            },
        ) = request;
        let wrap = HostNftPurseRequestReceiveAddressError::V1;
        let session = self.nft_purse_session(wrap)?;
        let product_id = self.product_id();
        let target = match target {
            Some(target) if target != product_id => {
                Self::nft_purse_grant(
                    receive_for_authorization(self.platform.as_ref(), &product_id, &target).await,
                    wrap,
                )?;
                target
            }
            _ => {
                Self::nft_purse_grant(
                    access_authorization(self.platform.as_ref(), &product_id, None).await,
                    wrap,
                )?;
                product_id.clone()
            }
        };
        let address = self
            .authority
            .nft_purse_request_receive_address(cx, &session, target, product_id, idempotency_key)
            .await
            .map_err(|err| nft_purse_call_error(err, wrap))?;
        Ok(HostNftPurseRequestReceiveAddressResponse::V1(
            v01::HostNftPurseRequestReceiveAddressResponse { address },
        ))
    }

    #[instrument(skip_all, fields(runtime.method = "nft_purse.transfer"))]
    async fn transfer(
        &self,
        cx: &CallContext,
        request: HostNftPurseTransferRequest,
    ) -> Subscription<HostNftPurseTransferItem, CallError<HostNftPurseTransferError>> {
        let HostNftPurseTransferRequest::V1(v01::HostNftPurseTransferRequest { instance, to }) =
            request;
        let wrap = HostNftPurseTransferError::V1;
        let (session, product_id) = match self.nft_purse_granted_session(None, wrap).await {
            Ok(granted) => granted,
            Err(err) => return Subscription::interrupted(err),
        };

        let (sender, receiver) = futures::channel::mpsc::unbounded();
        let progress_sender = sender.clone();
        let progress: Arc<dyn Fn(v01::NftPurseTransferStatus) + Send + Sync> =
            Arc::new(move |status| {
                let _ = progress_sender.unbounded_send(Ok(HostNftPurseTransferItem::V1(status)));
            });
        let authority = self.authority.clone();
        let cx = CallContext::with_request_id(cx.request_id().to_string());
        (self.services.spawner)(Box::pin(async move {
            let outcome = authority
                .nft_purse_transfer(&cx, &session, product_id, instance, to, progress)
                .await;
            let terminal = match outcome {
                Ok(_) => Ok(HostNftPurseTransferItem::V1(
                    v01::NftPurseTransferStatus::Landed,
                )),
                Err(NftPurseAuthorityError::Service(error)) => Ok(HostNftPurseTransferItem::V1(
                    v01::NftPurseTransferStatus::Failed { error },
                )),
                Err(err) => Err(nft_purse_call_error(err, wrap)),
            };
            let _ = sender.unbounded_send(terminal);
            // Dropping the sender ends the stream after the terminal item.
        }));
        Subscription::new(receiver)
    }

    #[instrument(skip_all, fields(runtime.method = "nft_purse.list_subscribe"))]
    async fn list_subscribe(
        &self,
        cx: &CallContext,
        request: HostNftPurseListSubscribeRequest,
    ) -> Subscription<HostNftPurseListSubscribeItem, CallError<HostNftPurseListSubscribeError>>
    {
        let HostNftPurseListSubscribeRequest::V1(v01::HostNftPurseListSubscribeRequest {
            collections,
        }) = request;
        let wrap = HostNftPurseListSubscribeError::V1;
        let (session, product_id) = match self
            .nft_purse_granted_session(collections.clone(), wrap)
            .await
        {
            Ok(granted) => granted,
            Err(err) => return Subscription::interrupted(err),
        };
        let first = match self
            .authority
            .nft_purse_list(cx, &session, product_id.clone(), collections.clone())
            .await
        {
            Ok(items) => items,
            Err(err) => return Subscription::interrupted(nft_purse_call_error(err, wrap)),
        };

        let (sender, receiver) = futures::channel::mpsc::unbounded();
        let item = |items: Vec<truapi::latest::NftPurseItem>| {
            Ok(HostNftPurseListSubscribeItem::V1(
                v01::HostNftPurseListSubscribeItem { items },
            ))
        };
        let _ = sender.unbounded_send(item(first.clone()));
        let authority = self.authority.clone();
        let cx = CallContext::with_request_id(cx.request_id().to_string());
        (self.services.spawner)(Box::pin(async move {
            let mut last = first;
            loop {
                futures_timer::Delay::new(LIST_POLL_INTERVAL).await;
                if sender.is_closed() {
                    break;
                }
                match authority
                    .nft_purse_list(&cx, &session, product_id.clone(), collections.clone())
                    .await
                {
                    Ok(items) => {
                        if items != last && sender.unbounded_send(item(items.clone())).is_err() {
                            break;
                        }
                        last = items;
                    }
                    // A failed read interrupts the stream; the product
                    // re-subscribes and sees the error on its next call.
                    Err(err) => {
                        let _ = sender.unbounded_send(Err(nft_purse_call_error(err, wrap)));
                        break;
                    }
                }
            }
        }));
        Subscription::new(receiver)
    }
}
