//! Unified [`Permissions`] trait.

use crate::versioned::permissions::{
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
    /// ```
    #[wire(id = 1)]
    async fn request_remote_permission(
        &self,
        cx: &CallContext,
        request: RemotePermissionRequest,
    ) -> Result<RemotePermissionResponse, CallError<RemotePermissionError>>;
}
