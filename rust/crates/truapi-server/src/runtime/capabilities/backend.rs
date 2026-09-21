//! Product-facing backend capability adapter.

use tracing::instrument;
use truapi::api::Backend;
use truapi::versioned::backend::{
    HostBackendError, HostBackendListError, HostBackendListRequest, HostBackendListResponse,
    HostBackendRequest, HostBackendResponse,
};
use truapi::{CallContext, CallError};

use crate::host_logic::backend::{screen_authorization, screen_request, screen_response};
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

        // Authenticating a backend that answers per person is the core's job,
        // not the product's and not the host's: nothing a product sends can
        // reach this argument. No session source is wired in yet, so every
        // call goes out with the host's credential alone.
        let authorization: Option<String> = None;
        if let Some(authorization) = &authorization {
            screen_authorization(authorization).map_err(domain)?;
        }

        let mut response = host
            .backend_request(&self.product, inner, authorization)
            .await
            .map_err(domain)?;
        // The host owes the allowlist and the cap; this catches one that skips them.
        screen_response(&mut response).map_err(domain)?;
        Ok(HostBackendResponse::V1(response))
    }

    #[instrument(skip_all, fields(runtime.method = "backend.list"))]
    async fn list(
        &self,
        _cx: &CallContext,
        _request: HostBackendListRequest,
    ) -> Result<HostBackendListResponse, CallError<HostBackendListError>> {
        let host = self.backend_host()?;
        host.backends(&self.product)
            .await
            .map(HostBackendListResponse::V1)
            .map_err(|error| CallError::Domain(HostBackendListError::V1(error)))
    }
}

fn domain(error: truapi::latest::HostBackendError) -> CallError<HostBackendError> {
    CallError::Domain(HostBackendError::V1(error))
}
