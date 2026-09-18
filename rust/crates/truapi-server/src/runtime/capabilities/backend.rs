//! Product-facing backend capability adapter.

use tracing::instrument;
use truapi::api::Backend;
use truapi::versioned::backend::{HostBackendError, HostBackendRequest, HostBackendResponse};
use truapi::{CallContext, CallError};

use crate::host_logic::backend::{screen_request, screen_response};
use crate::runtime::ProductRuntimeHost;

#[truapi::async_trait]
impl Backend for ProductRuntimeHost {
    #[instrument(skip_all, fields(runtime.method = "backend.request"))]
    async fn request(
        &self,
        _cx: &CallContext,
        request: HostBackendRequest,
    ) -> Result<HostBackendResponse, CallError<HostBackendError>> {
        let HostBackendRequest::V1(inner) = request;
        let host = self.backend_host()?;

        screen_request(&inner).map_err(domain)?;

        let mut response = host
            .backend_request(&self.product, inner)
            .await
            .map_err(domain)?;
        // The host owes the allowlist and the cap; this catches one that skips them.
        screen_response(&mut response).map_err(domain)?;
        Ok(HostBackendResponse::V1(response))
    }
}

fn domain(error: truapi::latest::HostBackendError) -> CallError<HostBackendError> {
    CallError::Domain(HostBackendError::V1(error))
}
