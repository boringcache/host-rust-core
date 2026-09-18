//! The NFT purses: per-product `pallet-scarcity` purses over the wallet's
//! root, one NFT per host-derived key.
//!
//! Custody is context: an item belongs to whichever product's purse holds it.
//! Only the signing host reaches purse keys, so only it runs the engine; a
//! pairing host relays each purse operation to its paired signing host over
//! SSO and keeps no purse state of its own. Products reach the purses through
//! the `NftPurse` service; the wallet reaches them directly.

#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod chain;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod engine;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod store;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod transfer;

use std::sync::Arc;

use truapi::latest::{NftPurseError, NftPurseTransferStatus};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use engine::NftPurses;

use crate::runtime::authority::AuthorityError;

/// Progress sink for a transfer: `Started` after broadcast, `InBlock` on
/// inclusion. The terminal outcome is the call's return value.
pub(crate) type TransferProgress = Arc<dyn Fn(NftPurseTransferStatus) + Send + Sync>;

/// A purse call's failure as the account authority reports it: either the
/// authority could not serve the caller at all, or the purses answered with a
/// service error.
#[derive(Debug, derive_more::Display)]
pub(crate) enum NftPurseAuthorityError {
    /// Session or capability failure.
    #[display("{_0}")]
    Authority(AuthorityError),
    /// The service's own failure.
    #[display("{_0}")]
    Service(NftPurseError),
}

impl NftPurseAuthorityError {
    /// Flatten into the service's error, the shape the SSO relay and the wire
    /// carry: a missing session is `NotConnected`, a refusal is `Rejected`,
    /// and any other authority failure keeps its reason.
    pub(crate) fn into_service_error(self) -> NftPurseError {
        match self {
            Self::Authority(AuthorityError::Disconnected) => NftPurseError::NotConnected,
            Self::Authority(AuthorityError::Rejected) => NftPurseError::Rejected,
            Self::Authority(other) => NftPurseError::Unknown {
                reason: other.to_string(),
            },
            Self::Service(error) => error,
        }
    }
}

impl From<AuthorityError> for NftPurseAuthorityError {
    fn from(err: AuthorityError) -> Self {
        Self::Authority(err)
    }
}

impl From<NftPurseError> for NftPurseAuthorityError {
    fn from(err: NftPurseError) -> Self {
        Self::Service(err)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl From<engine::Error> for NftPurseAuthorityError {
    fn from(err: engine::Error) -> Self {
        Self::Service(err.to_service_error())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl From<transfer::TransferError> for NftPurseAuthorityError {
    fn from(err: transfer::TransferError) -> Self {
        Self::Service(err.to_service_error())
    }
}
