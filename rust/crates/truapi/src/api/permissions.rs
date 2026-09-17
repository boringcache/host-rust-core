//! Unified [`Permissions`] trait.

use crate::versioned::permissions::{
    AuthorizeMediaCaptureError, AuthorizeMediaCaptureRequest, AuthorizeMediaCaptureResponse,
    AuthorizeNetworkAccessError, AuthorizeNetworkAccessRequest, AuthorizeNetworkAccessResponse,
    AuthorizeWebRtcError, AuthorizeWebRtcRequest, AuthorizeWebRtcResponse,
    HostDevicePermissionError, HostDevicePermissionRequest, HostDevicePermissionResponse,
    RemotePermissionError, RemotePermissionRequest, RemotePermissionResponse,
};
use crate::{CallContext, CallError};
use crate::{wire, wire_trait};

/// Permission request methods.
#[wire_trait(id = 10)]
#[crate::async_trait]
pub trait Permissions: Send + Sync {
    /// Request a device-capability permission from the user.
    ///
    /// ```ts
    /// const result = await truapi.permissions.requestDevicePermission("Camera");
    /// assert(result.isOk(), "requestDevicePermission failed:", result);
    /// console.log("device permission result:", result.value);
    /// ```
    #[wire(id = 0)]
    async fn request_device_permission(
        &self,
        cx: &CallContext,
        request: HostDevicePermissionRequest,
    ) -> Result<HostDevicePermissionResponse, CallError<HostDevicePermissionError>>;

    /// Request a remote-operation permission.
    ///
    /// ```ts
    /// const result = await truapi.permissions.requestRemotePermission({
    ///   permission: { tag: "Remote", value: { domains: ["api.example.com"] } },
    /// });
    /// assert(result.isOk(), "requestRemotePermission failed:", result);
    /// console.log("remote permission result:", result.value);
    /// ```
    #[wire(id = 1)]
    async fn request_remote_permission(
        &self,
        cx: &CallContext,
        request: RemotePermissionRequest,
    ) -> Result<RemotePermissionResponse, CallError<RemotePermissionError>>;

    /// Authorize one network operation for the current product, consuming an
    /// available one-use grant. Used by the host's fetch, XHR and WebSocket
    /// wrappers before sending a request or opening a connection.
    #[wire(id = 2, internal)]
    async fn authorize_network_access(
        &self,
        cx: &CallContext,
        request: AuthorizeNetworkAccessRequest,
    ) -> Result<AuthorizeNetworkAccessResponse, CallError<AuthorizeNetworkAccessError>>;

    /// Authorize one peer connection, consuming an available one-use grant.
    #[wire(id = 3, internal)]
    async fn authorize_web_rtc(
        &self,
        cx: &CallContext,
        request: AuthorizeWebRtcRequest,
    ) -> Result<AuthorizeWebRtcResponse, CallError<AuthorizeWebRtcError>>;

    /// Authorize one media capture, consuming available one-use camera and
    /// microphone grants for the requested capabilities.
    #[wire(id = 4, internal)]
    async fn authorize_media_capture(
        &self,
        cx: &CallContext,
        request: AuthorizeMediaCaptureRequest,
    ) -> Result<AuthorizeMediaCaptureResponse, CallError<AuthorizeMediaCaptureError>>;
}
