#if canImport(WebKit)

import Foundation
import WebKit

public enum ProductScriptInstallationError: Error, Equatable {
    case invalidProductURL
    case webViewAlreadyLoaded
    case persistentDataStoreUnsupported
    case navigationDelegateAlreadyInstalled
    case contentRulesUnavailable
}

struct ProductNetworkOrigin: Hashable {
    let scheme: String
    let host: String
    let port: Int?

    init(_ url: URL) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil,
              !["file", "data", "blob", "javascript"].contains(scheme) else {
            throw ProductScriptInstallationError.invalidProductURL
        }
        self.scheme = scheme
        self.host = host
        let defaultPort = ["http": 80, "https": 443, "ws": 80, "wss": 443][scheme]
        port = components.port == defaultPort ? nil : components.port
    }

    var prefix: String {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        components.path = "/"
        return components.url!.absoluteString
    }

    func matches(_ securityOrigin: WKSecurityOrigin) -> Bool {
        let defaultPort = ["http": 80, "https": 443, "ws": 80, "wss": 443][scheme]
        let otherPort = securityOrigin.port == 0 || securityOrigin.port == defaultPort
            ? nil : securityOrigin.port
        return scheme == securityOrigin.protocol.lowercased()
            && host == securityOrigin.host.lowercased() && port == otherPort
    }
}

enum ProductNetworkRules {
    static func encode(
        productOrigin: ProductNetworkOrigin,
        bridgeURL: String,
        remoteOrigins: Set<ProductNetworkOrigin>
    ) throws -> String {
        var rules: [[String: Any]] = [
            ["trigger": ["url-filter": "^(https?|wss?)://"], "action": ["type": "block"]],
            allow("^" + NSRegularExpression.escapedPattern(for: productOrigin.prefix)),
            allow("^" + NSRegularExpression.escapedPattern(for: bridgeURL) + "$"),
        ]
        for origin in remoteOrigins.sorted(by: { $0.prefix < $1.prefix }) {
            rules.append(allow(
                "^" + NSRegularExpression.escapedPattern(for: origin.prefix), rawOnly: true
            ))
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: rules), as: UTF8.self)
    }

    private static func allow(_ pattern: String, rawOnly: Bool = false) -> [String: Any] {
        var trigger: [String: Any] = ["url-filter": pattern, "url-filter-is-case-sensitive": true]
        if rawOnly { trigger["resource-type"] = ["raw"] }
        return ["trigger": trigger, "action": ["type": "ignore-previous-rules"]]
    }
}

/// Retain with the product web view and dispose before closing its execution.
@MainActor
public final class ProductScriptInstallation: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    private struct Reference {
        weak var installation: ProductScriptInstallation?
    }

    private static var installations: [Reference] = []
    static let handlerName = "__truapi_network_authorize"
    static let bootstrap = """
    (() => {
      const handler = window.webkit.messageHandlers.__truapi_network_authorize;
      window.__truapi_network__ = handler.postMessage.bind(handler);
    })();
    """

    private weak var webView: WKWebView?
    private weak var controller: WKUserContentController?
    private let execution: any TrUAPIProductExecutionProtocol
    private let productOrigin: ProductNetworkOrigin
    private let bridgeURL: String
    private let store: WKContentRuleListStore
    private let identifier: String
    private let baseline: WKContentRuleList
    private var current: WKContentRuleList
    private var remoteOrigins: Set<ProductNetworkOrigin> = []
    private var pending: Task<Bool, Never>?
    private var pendingRefresh: Task<Void, Error>?
    private var generation = 0
    private var policyRevision = 0
    private var disposed = false

    private init(
        webView: WKWebView,
        execution: any TrUAPIProductExecutionProtocol,
        productOrigin: ProductNetworkOrigin,
        bridgeURL: String,
        store: WKContentRuleListStore,
        identifier: String,
        baseline: WKContentRuleList
    ) {
        self.webView = webView
        controller = webView.configuration.userContentController
        self.execution = execution
        self.productOrigin = productOrigin
        self.bridgeURL = bridgeURL
        self.store = store
        self.identifier = identifier
        self.baseline = baseline
        current = baseline
    }

    static func install(
        webView: WKWebView,
        execution: any TrUAPIProductExecutionProtocol,
        endpoint: WsBridgeEndpoint,
        productURL: URL
    ) async throws -> ProductScriptInstallation {
        try validate(webView)
        let origin = try ProductNetworkOrigin(productURL)
        let bridgeURL = "ws://127.0.0.1:\(endpoint.port)/?t=\(endpoint.token)"
        let identifier = "truapi-network-" + UUID().uuidString
        guard let store = WKContentRuleListStore.default() else {
            throw ProductScriptInstallationError.contentRulesUnavailable
        }
        let baseline = try await compile(
            store: store, identifier: identifier + "-base",
            rules: ProductNetworkRules.encode(productOrigin: origin, bridgeURL: bridgeURL, remoteOrigins: [])
        )
        try validate(webView)
        let installation = ProductScriptInstallation(
            webView: webView, execution: execution, productOrigin: origin,
            bridgeURL: bridgeURL, store: store, identifier: identifier, baseline: baseline
        )
        let controller = webView.configuration.userContentController
        controller.add(baseline)
        controller.addScriptMessageHandler(installation, contentWorld: .page, name: handlerName)
        webView.navigationDelegate = installation
        installations.removeAll { $0.installation == nil }
        installations.append(Reference(installation: installation))
        return installation
    }

    static func validate(_ webView: WKWebView) throws {
        guard webView.url == nil, !webView.isLoading else {
            throw ProductScriptInstallationError.webViewAlreadyLoaded
        }
        guard !webView.configuration.websiteDataStore.isPersistent else {
            throw ProductScriptInstallationError.persistentDataStoreUnsupported
        }
        guard webView.navigationDelegate == nil else {
            throw ProductScriptInstallationError.navigationDelegateAlreadyInstalled
        }
    }

    /// Apply this decision in a composing navigation delegate before allowing a load.
    public func allowsNavigation(to url: URL?) -> Bool {
        guard !disposed, let url, let origin = try? ProductNetworkOrigin(url) else { return false }
        return origin == productOrigin
    }

    public func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(allowsNavigation(to: navigationAction.request.url) ? .allow : .cancel)
    }

    public func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard !disposed, message.webView === webView, message.frameInfo.isMainFrame,
              productOrigin.matches(message.frameInfo.securityOrigin),
              let url = message.body as? String else {
            replyHandler(false, nil)
            return
        }
        let task = enqueue { await self.authorize(url) }
        Task { @MainActor in replyHandler(await task.value, nil) }
    }

    /// Use this instead of the execution's direct setter while product web views exist.
    /// Every live installation is restricted before shared Rust decisions change.
    public func setPermissionAuthorizationStatus(
        request: PermissionAuthorizationRequest,
        status: PermissionAuthorizationStatus
    ) async throws {
        guard !disposed else { throw CancellationError() }
        let active = Self.installations.compactMap { $0.installation }.filter { !$0.disposed }
        let snapshots = active.map { installation in
            let origins = installation.remoteOrigins
            installation.restrictToProduct()
            return (installation, origins)
        }
        try execution.setPermissionAuthorizationStatus(request: request, status: status)
        let updates = snapshots.map { installation, origins in
            Task { @MainActor in
                do {
                    try await installation.refresh(origins)
                    return !installation.disposed
                } catch {
                    return false
                }
            }
        }
        for update in updates {
            guard await update.value else { throw ProductScriptInstallationError.contentRulesUnavailable }
        }
    }

    public func dispose() {
        guard !disposed else { return }
        disposed = true
        restrictToProduct()
        controller?.removeScriptMessageHandler(forName: Self.handlerName, contentWorld: .page)
        pending?.cancel()
        pending = nil
        pendingRefresh?.cancel()
        pendingRefresh = nil
        for suffix in ["-base", "-0", "-1"] {
            store.removeContentRuleList(forIdentifier: identifier + suffix, completionHandler: nil)
        }
        Self.installations.removeAll { $0.installation == nil || $0.installation === self }
    }

    private func enqueue(_ operation: @escaping @MainActor () async -> Bool) -> Task<Bool, Never> {
        let previous = pending
        let task = Task { @MainActor in
            _ = await previous?.value
            return await operation()
        }
        pending = task
        return task
    }

    private func restrictToProduct() {
        policyRevision += 1
        useBaseline()
    }

    private func useBaseline() {
        if current !== baseline {
            controller?.add(baseline)
            controller?.remove(current)
        }
        current = baseline
        remoteOrigins = []
    }

    private func authorize(_ rawURL: String) async -> Bool {
        guard !disposed, let url = URL(string: rawURL),
              let origin = try? ProductNetworkOrigin(url) else { return false }
        let revision = policyRevision
        do {
            var candidates = remoteOrigins
            if origin != productOrigin {
                guard ["http", "https"].contains(origin.scheme),
                      try await execution.authorizeNetworkAccess(url: rawURL) == .authorized else {
                    try await refresh(candidates)
                    return false
                }
                candidates.insert(origin)
            }
            try await refresh(candidates)
            return !disposed && (origin == productOrigin || remoteOrigins.contains(origin))
        } catch {
            if revision == policyRevision { restrictToProduct() }
            return false
        }
    }

    private func refresh(_ candidates: Set<ProductNetworkOrigin>) async throws {
        let previous = pendingRefresh
        let revision = policyRevision
        let task = Task { @MainActor in
            _ = try? await previous?.value
            do {
                try await self.refreshRules(candidates.union(self.remoteOrigins), revision: revision)
            } catch {
                if revision == self.policyRevision { self.restrictToProduct() }
                throw error
            }
        }
        pendingRefresh = task
        try await task.value
    }

    private func refreshRules(
        _ candidates: Set<ProductNetworkOrigin>, revision: Int
    ) async throws {
        guard !disposed, revision == policyRevision else { throw CancellationError() }
        var approved: Set<ProductNetworkOrigin> = []
        for origin in candidates {
            let status = try await execution.permissionAuthorizationStatus(request: .remote(
                RemotePermissionRequest(permission: .remote(domains: [origin.host]))
            ))
            if status == .authorized { approved.insert(origin) }
        }
        guard !disposed, revision == policyRevision else { throw CancellationError() }
        guard approved != remoteOrigins else { return }
        if approved.isEmpty {
            useBaseline()
            return
        }
        generation += 1
        let rules = try ProductNetworkRules.encode(
            productOrigin: productOrigin, bridgeURL: bridgeURL, remoteOrigins: approved
        )
        let replacement = try await Self.compile(
            store: store, identifier: identifier + "-\(generation % 2)", rules: rules
        )
        guard !disposed, revision == policyRevision else { throw CancellationError() }
        controller?.add(replacement)
        controller?.remove(current)
        current = replacement
        remoteOrigins = approved
    }

    private static func compile(
        store: WKContentRuleListStore, identifier: String, rules: String
    ) async throws -> WKContentRuleList {
        try await withCheckedThrowingContinuation { continuation in
            store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: rules) { list, error in
                if let list { continuation.resume(returning: list) }
                else { continuation.resume(throwing: error ?? ProductScriptInstallationError.contentRulesUnavailable) }
            }
        }
    }
}

#endif
