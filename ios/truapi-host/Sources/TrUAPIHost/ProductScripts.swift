#if canImport(WebKit)

import WebKit

public extension TrUAPIHost {
    /// Installs the shared container and native network enforcement before loading a product.
    /// Retain the returned installation and dispose it before closing the execution.
    /// Use an unloaded view with a nonpersistent data store and no navigation delegate.
    /// Composing delegates must preserve
    /// the installation's `allowsNavigation(to:)` decision.
    @MainActor
    static func installProductScripts(
        into webView: WKWebView,
        execution: any TrUAPIProductExecutionProtocol,
        endpoint: WsBridgeEndpoint,
        productURL: URL
    ) async throws -> ProductScriptInstallation {
        try ProductScriptInstallation.validate(webView)
        let container = try ContainerScriptBundle.load()
        let webRtcAllowed = try await execution.permissionAuthorizationStatus(
            request: .remote(RemotePermissionRequest(permission: .webRtc))
        ) == .authorized
        let installation = try await ProductScriptInstallation.install(
            webView: webView, execution: execution, endpoint: endpoint, productURL: productURL
        )
        let controller = webView.configuration.userContentController
        controller.addUserScript(WKUserScript(
            source: ProductScriptInstallation.bootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        addProductScripts(
            into: controller, endpoint: endpoint, container: container, webRtcAllowed: webRtcAllowed
        )
        return installation
    }

    /// Installs the container without a remote network adapter. Cross-origin fetch stays denied.
    /// Use the web-view overload to enable permission-controlled remote requests.
    @MainActor
    static func installProductScripts(
        into controller: WKUserContentController,
        execution: any TrUAPIProductExecutionProtocol,
        endpoint: WsBridgeEndpoint
    ) async throws {
        let webRtcAllowed = try await execution.permissionAuthorizationStatus(
            request: .remote(RemotePermissionRequest(permission: .webRtc))
        ) == .authorized
        addProductScripts(
            into: controller, endpoint: endpoint,
            container: try ContainerScriptBundle.load(), webRtcAllowed: webRtcAllowed
        )
    }

    @MainActor
    private static func addProductScripts(
        into controller: WKUserContentController,
        endpoint: WsBridgeEndpoint,
        container: String,
        webRtcAllowed: Bool
    ) {
        controller.addUserScript(WKUserScript(
            source: LocalhostBridgeBootstrap.script(
                port: endpoint.port, token: endpoint.token, webRtcAllowed: webRtcAllowed
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addUserScript(WKUserScript(
            source: container,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
    }
}

#endif
