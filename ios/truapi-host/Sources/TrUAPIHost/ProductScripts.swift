#if canImport(WebKit)

import WebKit

public extension TrUAPIHost {
    /// Installs the bridge and shared container before loading a product.
    @MainActor
    static func installProductScripts(
        into webView: WKWebView,
        execution: any TrUAPIProductExecutionProtocol,
        endpoint: WsBridgeEndpoint
    ) async throws {
        let container = try ContainerScriptBundle.load()
        let webRtcAllowed = try await execution.permissionAuthorizationStatus(
            request: .remote(RemotePermissionRequest(permission: .webRtc))
        ) == .authorized
        let controller = webView.configuration.userContentController
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
