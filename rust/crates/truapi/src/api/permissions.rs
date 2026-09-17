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
    ///   permission: { tag: "Remote", value: { domains: ["api.frankfurter.dev"] } },
    /// });
    /// assert(result.isOk(), "requestRemotePermission failed:", result);
    /// console.log("remote permission result:", result.value);
    /// assert(result.value.granted, "Remote permission was denied");
    ///
    /// const response = await fetch("https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD");
    /// assert(response.ok, "Fetch after permission grant failed:", response.status);
    /// const rates = await response.json();
    /// assert(Array.isArray(rates) && rates.length > 0, "Expected exchange rates:", rates);
    /// console.log("exchange rates:", rates);
    ///
    /// const xhrRates = await new Promise((resolve, reject) => {
    ///   const request = new XMLHttpRequest();
    ///   request.open("GET", "https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD");
    ///   request.responseType = "json";
    ///   request.timeout = 15000;
    ///   request.onload = () => request.status === 200
    ///     ? resolve(request.response)
    ///     : reject(new Error(`XHR failed: ${request.status}`));
    ///   request.onerror = request.ontimeout = () => reject(new Error("XHR failed"));
    ///   request.send();
    /// });
    /// assert(Array.isArray(xhrRates) && xhrRates.length > 0, "Expected XHR exchange rates:", xhrRates);
    /// console.log("XHR exchange rates:", xhrRates);
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
    ///
    /// ```ts
    /// const result = await truapi.permissions.authorizeNetworkAccess({
    ///   url: "https://api.frankfurter.dev/v2/rates?base=EUR&quotes=USD",
    /// });
    /// assert(result.isOk(), "network authorization failed:", result);
    /// console.log("network operation allowed:", result.value.allowed);
    /// ```
    #[wire(id = 2)]
    async fn authorize_network_access(
        &self,
        cx: &CallContext,
        request: AuthorizeNetworkAccessRequest,
    ) -> Result<AuthorizeNetworkAccessResponse, CallError<AuthorizeNetworkAccessError>>;

    /// Authorize one peer connection, consuming an available one-use grant.
    ///
    /// ```ts
    /// const result = await truapi.permissions.authorizeWebRtc();
    /// assert(result.isOk(), "WebRTC authorization failed:", result);
    /// console.log("peer connection allowed:", result.value.allowed);
    /// ```
    #[wire(id = 3)]
    async fn authorize_web_rtc(
        &self,
        cx: &CallContext,
        request: AuthorizeWebRtcRequest,
    ) -> Result<AuthorizeWebRtcResponse, CallError<AuthorizeWebRtcError>>;

    /// Authorize one media capture, consuming available one-use camera and
    /// microphone grants for the requested capabilities.
    ///
    /// ```ts
    /// const result = await truapi.permissions.authorizeMediaCapture({
    ///   audio: true,
    ///   video: true,
    /// });
    /// assert(result.isOk(), "media capture authorization failed:", result);
    /// console.log("media capture allowed:", result.value.allowed);
    /// ```
    #[wire(id = 4)]
    async fn authorize_media_capture(
        &self,
        cx: &CallContext,
        request: AuthorizeMediaCaptureRequest,
    ) -> Result<AuthorizeMediaCaptureResponse, CallError<AuthorizeMediaCaptureError>>;
}
