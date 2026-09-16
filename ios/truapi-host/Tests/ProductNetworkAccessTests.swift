#if canImport(UIKit) && canImport(WebKit)

import Foundation
import Network
import Testing
import UIKit
import WebKit
@testable import TrUAPIHost

@Suite(.serialized)
@MainActor
struct ProductNetworkAccessTests {
    @Test(.timeLimit(.minutes(1)), arguments: [PermissionAuthorizationStatus.authorized, .denied])
    func overlappingSettingsRefreshRegisteredOrigins(status: PermissionAuthorizationStatus) async throws {
        let product = try await NetworkTestProduct.open()
        defer { product.close() }
        let remote = product.server.url(host: "127.0.0.1", path: "/allowed")
        let redirect = product.server.url(host: "localhost", path: "/redirect-revoked")
        #expect(try await fetch(product.webView, remote) == "allowed")
        #expect(try await fetch(product.webView, redirect) == "allowed")

        let pause = NetworkTestPause()
        defer { pause.resume() }
        product.execution.nextPermissionRead = pause
        var writes = product.execution.writes.stream.makeAsyncIterator()
        let first = Task {
            try await product.installation.setPermissionAuthorizationStatus(
                request: .remote(RemotePermissionRequest(permission: .remote(domains: ["first.example"]))),
                status: .denied
            )
        }
        defer { first.cancel() }
        try await pause.waitUntilSuspended()
        try #require(try await withNetworkTestTimeout("first settings write") { await writes.next() } != nil)
        let second = Task {
            try await product.installation.setPermissionAuthorizationStatus(
                request: .remote(RemotePermissionRequest(permission: .remote(domains: ["127.0.0.1"]))),
                status: status
            )
        }
        defer { second.cancel() }
        try #require(try await withNetworkTestTimeout("second settings write") { await writes.next() } != nil)
        pause.resume()
        try await withNetworkTestTimeout("first settings refresh") { try await first.value }
        try await withNetworkTestTimeout("second settings refresh") { try await second.value }

        let expectedResponse = status == .authorized ? "allowed" : "denied"
        let expectedRequests = status == .authorized ? 3 : 2
        #expect(try await fetch(product.webView, redirect) == expectedResponse)
        #expect(product.server.requests(path: "/allowed") == expectedRequests)
    }

    @Test(.timeLimit(.minutes(1)))
    func disposingAnotherViewDoesNotFailCommittedSettings() async throws {
        let product = try await NetworkTestProduct.open()
        defer { product.close() }
        #expect(try await fetch(product.webView, product.server.url(host: "127.0.0.1", path: "/allowed")) == "allowed")
        let store = try #require(WKContentRuleListStore.default())
        let existingRules = Set(try #require(await store.availableIdentifiers()))
        let other = try await NetworkTestProduct.open()
        defer { other.close() }
        #expect(try await fetch(other.webView, other.server.url(host: "127.0.0.1", path: "/allowed")) == "allowed")
        let otherRules = Set(try #require(await store.availableIdentifiers())).subtracting(existingRules)
        try #require(!otherRules.isEmpty)

        let pause = NetworkTestPause()
        defer { pause.resume() }
        other.execution.nextPermissionRead = pause
        let update = Task {
            try await product.installation.setPermissionAuthorizationStatus(
                request: .remote(RemotePermissionRequest(permission: .remote(domains: ["other.example"]))),
                status: .denied
            )
        }
        defer { update.cancel() }
        try await pause.waitUntilSuspended()
        other.installation.dispose()
        pause.resume()
        try await withNetworkTestTimeout("settings refresh after other view disposal") { try await update.value }
        let remainingRules = try await withNetworkTestTimeout("disposed view rule removal callbacks") {
            Set(try #require(await store.availableIdentifiers()))
        }
        #expect(otherRules.isDisjoint(with: remainingRules))

        let redirect = product.server.url(host: "localhost", path: "/redirect-revoked")
        #expect(try await fetch(product.webView, redirect) == "allowed")
        #expect(try await fetch(other.webView, other.server.url(host: "127.0.0.1", path: "/allowed")) == "denied")
        #expect(product.server.requests(path: "/allowed") == 2)
        #expect(other.server.requests(path: "/allowed") == 1)
    }

    @Test(.timeLimit(.minutes(1)))
    func permissionCallbackCanUpdateSettingsBeforeReturning() async throws {
        let server = try await NetworkTestServer.start()
        defer { server.stop() }
        let bridge = PromptUpdatingHostBridge()
        let runtime = try TrUAPIHostRuntime(
            bridge: bridge,
            runtimeConfig: HostRuntimeConfig(
                hostName: "network-tests",
                peopleChainGenesisHash: Data(repeating: 0, count: 32),
                bulletinChainGenesisHash: Data(repeating: 0, count: 32),
                networkSuffix: "paseo"
            )
        )
        let execution = try runtime.openProductExecution(
            bridge: bridge,
            configuration: ProductExecutionConfig(productId: "network.paseo", executionKind: .app)
        )
        defer { execution.close() }
        let ready = ProductPageReady()
        let configuration = networkTestConfiguration()
        configuration.userContentController.add(ready, name: "testReady")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let window = try NetworkTestWindow(webView)
        defer { window.close() }
        let productURL = server.url(host: "localhost", path: "/product")
        let installation = try await TrUAPIHost.installProductScripts(
            into: webView, execution: execution,
            endpoint: execution.startWsBridge(bindPort: 0), productURL: productURL
        )
        bridge.installation = installation
        defer { installation.dispose() }
        try await ready.load(webView, url: productURL)

        #expect(try await fetch(webView, server.url(host: "127.0.0.1", path: "/allowed")) == "allowed")
        #expect(server.requests(path: "/allowed") == 1)
    }

    @Test(.timeLimit(.minutes(1)))
    func grantedFetchUsesTheRustDecisionAndRevocationBlocksRedirects() async throws {
        let server = try await NetworkTestServer.start()
        defer { server.stop() }
        for hostname in ["localhost", "127.0.0.1", "[::1]"] {
            let status = try await withNetworkTestTimeout("loopback probe \(hostname)") {
                let (_, response) = try await URLSession.shared.data(for: URLRequest(
                    url: server.url(host: hostname, path: "/probe"), timeoutInterval: 15
                ))
                return (response as? HTTPURLResponse)?.statusCode
            }
            #expect(status == 200)
        }
        let bridge = StubHostBridge()
        let runtime = try TrUAPIHostRuntime(
            bridge: bridge,
            runtimeConfig: HostRuntimeConfig(
                hostName: "network-tests",
                peopleChainGenesisHash: Data(repeating: 0, count: 32),
                bulletinChainGenesisHash: Data(repeating: 0, count: 32),
                networkSuffix: "paseo"
            )
        )
        let execution = try runtime.openProductExecution(
            bridge: bridge,
            configuration: ProductExecutionConfig(productId: "network.paseo", executionKind: .app)
        )
        defer { execution.close() }
        let endpoint = try execution.startWsBridge(bindPort: 0)
        let productURL = server.url(host: "localhost", path: "/product")
        await #expect(throws: ProductScriptInstallationError.persistentDataStoreUnsupported) {
            try await TrUAPIHost.installProductScripts(
                into: WKWebView(frame: .zero, configuration: WKWebViewConfiguration()),
                execution: execution, endpoint: endpoint, productURL: productURL
            )
        }
        let ready = ProductPageReady()
        let occupiedConfiguration = networkTestConfiguration()
        let occupiedView = WKWebView(frame: .zero, configuration: occupiedConfiguration)
        occupiedView.navigationDelegate = ready
        await #expect(throws: ProductScriptInstallationError.navigationDelegateAlreadyInstalled) {
            try await TrUAPIHost.installProductScripts(
                into: occupiedView, execution: execution, endpoint: endpoint, productURL: productURL
            )
        }
        let configuration = networkTestConfiguration()
        configuration.userContentController.add(ready, name: "testReady")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let window = try NetworkTestWindow(webView)
        defer { window.close() }
        let installation = try await TrUAPIHost.installProductScripts(
            into: webView, execution: execution, endpoint: endpoint, productURL: productURL
        )
        defer { installation.dispose() }
        try await ready.load(webView, url: productURL)
        await #expect(throws: ProductScriptInstallationError.webViewAlreadyLoaded) {
            try await TrUAPIHost.installProductScripts(
                into: webView, execution: execution, endpoint: endpoint, productURL: productURL
            )
        }

        let remote = server.url(host: "127.0.0.1", path: "/allowed")
        #expect(try await fetch(webView, remote) == "denied")
        #expect(server.requests(path: "/allowed") == 0)

        let permission = PermissionAuthorizationRequest.remote(
            RemotePermissionRequest(permission: .remote(domains: ["127.0.0.1"]))
        )
        try await withNetworkTestTimeout("grant remote permission") {
            try await installation.setPermissionAuthorizationStatus(request: permission, status: .authorized)
        }
        #expect(try await fetch(webView, remote) == "allowed")
        #expect(server.requests(path: "/allowed") == 1)

        let redirect = server.url(host: "127.0.0.1", path: "/redirect-denied")
        #expect(try await fetch(webView, redirect) == "denied")
        #expect(server.requests(path: "/blocked") == 0)

        try await withNetworkTestTimeout("grant redirect target permission") {
            try await installation.setPermissionAuthorizationStatus(
                request: .remote(RemotePermissionRequest(permission: .remote(domains: ["[::1]"]))),
                status: .authorized
            )
        }
        #expect(try await fetch(webView, redirect) == "denied")
        #expect(server.requests(path: "/blocked") == 0)

        let secondExecution = try runtime.openProductExecution(
            bridge: bridge,
            configuration: ProductExecutionConfig(productId: "network.paseo", executionKind: .app)
        )
        defer { secondExecution.close() }
        let secondReady = ProductPageReady()
        let secondConfiguration = networkTestConfiguration()
        secondConfiguration.userContentController.add(secondReady, name: "testReady")
        let secondWebView = WKWebView(frame: .zero, configuration: secondConfiguration)
        let secondWindow = try NetworkTestWindow(secondWebView)
        defer { secondWindow.close() }
        let secondInstallation = try await TrUAPIHost.installProductScripts(
            into: secondWebView, execution: secondExecution,
            endpoint: secondExecution.startWsBridge(bindPort: 0), productURL: productURL
        )
        defer { secondInstallation.dispose() }
        try await secondReady.load(secondWebView, url: productURL)
        #expect(try await fetch(secondWebView, remote) == "allowed")
        #expect(server.requests(path: "/allowed") == 2)
        let allowedPreload = server.url(host: "127.0.0.1", path: "/preload-allowed")
        #expect(try await preload(secondWebView, allowedPreload) == "loaded")
        #expect(server.requests(path: "/preload-allowed") == 1)

        try await withNetworkTestTimeout("revoke remote permission") {
            try await installation.setPermissionAuthorizationStatus(request: permission, status: .denied)
        }
        let productRedirect = server.url(host: "localhost", path: "/redirect-revoked")
        #expect(try await fetch(webView, productRedirect) == "denied")
        #expect(server.requests(path: "/allowed") == 2)
        let revokedPreload = server.url(host: "127.0.0.1", path: "/preload-revoked")
        #expect(try await preload(secondWebView, revokedPreload) == "blocked")
        #expect(server.requests(path: "/preload-revoked") == 0)

        installation.dispose()
        #expect(try await fetch(webView, remote) == "denied")
        #expect(server.requests(path: "/allowed") == 2)
    }

    @Test(.timeLimit(.minutes(1)))
    func networkRulesCompileWithoutBroadeningOriginsOrBridgeCredentials() async throws {
        let product = try ProductNetworkOrigin(URL(string: "polkadot://example.paseo/index.html")!)
        let remote = try ProductNetworkOrigin(URL(string: "https://api.example.com:8443/data")!)
        let bridge = "ws://127.0.0.1:1234/?t=exact-token"
        let rules = try ProductNetworkRules.encode(
            productOrigin: product, bridgeURL: bridge, remoteOrigins: [remote]
        )
        let store = try #require(WKContentRuleListStore.default())
        let identifier = "network-rules-test-" + UUID().uuidString
        let compiled = try await store.compileContentRuleList(
            forIdentifier: identifier, encodedContentRuleList: rules
        )
        try await store.removeContentRuleList(forIdentifier: identifier)
        _ = try #require(compiled)
        let decoded = try #require(JSONSerialization.jsonObject(with: Data(rules.utf8)) as? [[String: Any]])
        let allowed = decoded.filter { ($0["action"] as? [String: String])?["type"] == "ignore-previous-rules" }
            .compactMap { $0["trigger"] as? [String: Any] }
        let remoteTrigger = try #require(allowed.first { $0["resource-type"] as? [String] == ["raw"] })
        let remotePattern = try #require(remoteTrigger["url-filter"] as? String)
        #expect(matches(remotePattern, "https://api.example.com:8443/data"))
        let allowedPatterns = try allowed.map { try #require($0["url-filter"] as? String) }
        #expect(allowedPatterns.contains { matches($0, bridge) })
        for disallowedURL in [
            "https://api.example.com.attacker.test:8443/data",
            "https://api.example.com:443/data",
            bridge + "-other",
        ] {
            #expect(!allowedPatterns.contains { matches($0, disallowedURL) })
        }
    }

    private func fetch(_ webView: WKWebView, _ url: URL) async throws -> String {
        try await withNetworkTestTimeout("fetch \(url.absoluteString)") {
            try await webView.callAsyncJavaScript(
                "try { const response = await fetch(url); return await response.text(); } catch { return 'denied'; }",
                arguments: ["url": url.absoluteString], in: nil, contentWorld: .page
            ) as? String ?? "evaluation failed"
        }
    }

    private func preload(_ webView: WKWebView, _ url: URL) async throws -> String? {
        try await withNetworkTestTimeout("preload \(url.absoluteString)") {
            try await webView.callAsyncJavaScript("""
                return await new Promise(resolve => {
                  const link = document.createElement('link');
                  link.rel = 'preload'; link.as = 'fetch'; link.crossOrigin = 'anonymous';
                  link.onload = () => resolve('loaded'); link.onerror = () => resolve('blocked');
                  link.href = url; document.head.appendChild(link);
                });
                """, arguments: ["url": url.absoluteString], in: nil, contentWorld: .page) as? String
        }
    }

    private func matches(_ pattern: String, _ value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}

private struct NetworkTestTimeout: Error, CustomStringConvertible {
    let stage: String
    var description: String { "Timed out waiting for \(stage)" }
}

@MainActor
private func withNetworkTestTimeout<Value: Sendable>(
    _ stage: String, operation: @escaping @MainActor () async throws -> Value
) async throws -> Value {
    let result = AsyncThrowingStream<Value, Error>.makeStream()
    let timeout = Task {
        try await Task.sleep(for: .seconds(15))
        result.continuation.finish(throwing: NetworkTestTimeout(stage: stage))
    }
    let task = Task {
        do {
            result.continuation.yield(try await operation())
            result.continuation.finish()
        } catch {
            result.continuation.finish(throwing: error)
        }
    }
    defer {
        timeout.cancel()
        task.cancel()
    }
    var iterator = result.stream.makeAsyncIterator()
    guard let value = try await iterator.next() else { throw CancellationError() }
    return value
}

@MainActor
private func networkTestConfiguration() -> WKWebViewConfiguration {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    return configuration
}

@MainActor
private final class NetworkTestWindow {
    private let window: UIWindow

    init(_ webView: WKWebView) throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }, "Run WebKit tests in NetworkTestHost")
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        let controller = UIViewController()
        controller.view = webView
        window.rootViewController = controller
        window.makeKeyAndVisible()
        #expect(webView.window === window)
    }

    func close() {
        window.isHidden = true
        window.rootViewController = nil
        window.windowScene = nil
    }
}

@MainActor
private struct NetworkTestProduct {
    let server: NetworkTestServer
    let execution: PausedPermissionExecution
    let webView: WKWebView
    let installation: ProductScriptInstallation
    let window: NetworkTestWindow

    static func open() async throws -> NetworkTestProduct {
        let server = try await NetworkTestServer.start()
        do {
            let bridge = StubHostBridge()
            let runtime = try TrUAPIHostRuntime(bridge: bridge, runtimeConfig: HostRuntimeConfig(
                hostName: "network-tests", peopleChainGenesisHash: Data(repeating: 0, count: 32),
                bulletinChainGenesisHash: Data(repeating: 0, count: 32), networkSuffix: "paseo"
            ))
            let inner = try runtime.openProductExecution(
                bridge: bridge,
                configuration: ProductExecutionConfig(productId: "network.paseo", executionKind: .app)
            )
            try inner.setPermissionAuthorizationStatus(
                request: .remote(RemotePermissionRequest(permission: .remote(domains: ["127.0.0.1"]))),
                status: .authorized
            )
            let execution = PausedPermissionExecution(inner)
            let ready = ProductPageReady()
            let configuration = networkTestConfiguration()
            configuration.userContentController.add(ready, name: "testReady")
            let webView = WKWebView(frame: .zero, configuration: configuration)
            let window = try NetworkTestWindow(webView)
            let productURL = server.url(host: "localhost", path: "/product")
            do {
                let installation = try await TrUAPIHost.installProductScripts(
                    into: webView, execution: execution,
                    endpoint: execution.startWsBridge(bindPort: 0), productURL: productURL
                )
                do { try await ready.load(webView, url: productURL) }
                catch {
                    installation.dispose()
                    throw error
                }
                return NetworkTestProduct(
                    server: server, execution: execution, webView: webView,
                    installation: installation, window: window
                )
            } catch {
                window.close()
                throw error
            }
        } catch {
            server.stop()
            throw error
        }
    }

    func close() {
        installation.dispose()
        window.close()
        execution.close()
        server.stop()
    }
}

@MainActor
private final class NetworkTestPause {
    private let started = AsyncStream<Void>.makeStream()
    private let resumed = AsyncStream<Void>.makeStream()

    func suspend() async throws {
        started.continuation.yield(())
        started.continuation.finish()
        try await wait(for: resumed, stage: "permission read resume")
    }

    func waitUntilSuspended() async throws {
        try await wait(for: started, stage: "permission read suspension")
    }

    func resume() {
        resumed.continuation.yield(())
        resumed.continuation.finish()
    }

    private func wait(
        for signal: (stream: AsyncStream<Void>, continuation: AsyncStream<Void>.Continuation),
        stage: String
    ) async throws {
        try await withNetworkTestTimeout(stage) {
            var iterator = signal.stream.makeAsyncIterator()
            guard await iterator.next() != nil else { throw CancellationError() }
        }
    }
}

private final class PausedPermissionExecution: TrUAPIProductExecutionProtocol, @unchecked Sendable {
    private let inner: TrUAPIProductExecution
    let writes = AsyncStream<Void>.makeStream()
    @MainActor var nextPermissionRead: NetworkTestPause?

    init(_ inner: TrUAPIProductExecution) { self.inner = inner }

    func permissionAuthorizationStatus(
        request: PermissionAuthorizationRequest
    ) async throws -> PermissionAuthorizationStatus {
        let status = try await inner.permissionAuthorizationStatus(request: request)
        try await pauseNextRead()
        return status
    }

    @MainActor
    private func pauseNextRead() async throws {
        guard let pause = nextPermissionRead else { return }
        nextPermissionRead = nil
        try await pause.suspend()
    }

    func setPermissionAuthorizationStatus(
        request: PermissionAuthorizationRequest, status: PermissionAuthorizationStatus
    ) throws {
        try inner.setPermissionAuthorizationStatus(request: request, status: status)
        writes.continuation.yield(())
    }

    func authorizeNetworkAccess(url: String) async throws -> PermissionAuthorizationStatus {
        try await inner.authorizeNetworkAccess(url: url)
    }

    func startWsBridge(bindPort: UInt16) throws -> WsBridgeEndpoint { try inner.startWsBridge(bindPort: bindPort) }
    func stopWsBridge() { inner.stopWsBridge() }
    func close() {
        writes.continuation.finish()
        inner.close()
    }
    func publishChatAction(_ action: HostChatActionSubscribeItem) throws { try inner.publishChatAction(action) }
    func render(_ request: ProductRendererRenderRequest) throws -> AsyncThrowingStream<RendererNode, Error> {
        try inner.render(request)
    }
    func publishRendererAction(_ item: HostRendererActionSubscribeItem) throws { try inner.publishRendererAction(item) }
    func notifyThemeChanged(theme: HostThemeSubscribeItem) { inner.notifyThemeChanged(theme: theme) }
    func notifyLocaleChanged(locale: HostLocaleSubscribeItem) { inner.notifyLocaleChanged(locale: locale) }
    func notifyPreimageChanged(key: Data, value: Data?) { inner.notifyPreimageChanged(key: key, value: value) }
    func notifyChainResponse(connectionId: UInt32, json: String) {
        inner.notifyChainResponse(connectionId: connectionId, json: json)
    }
    func notifyChainClosed(connectionId: UInt32) { inner.notifyChainClosed(connectionId: connectionId) }
    func notifyChatRoomsChanged(rooms: [ChatRoom]) { inner.notifyChatRoomsChanged(rooms: rooms) }
    func sessionChatIdentityKey() throws -> Data? { try inner.sessionChatIdentityKey() }
    func notifyPocketCardsChanged(cards: [PocketCard]) { inner.notifyPocketCardsChanged(cards: cards) }
}

private final class PromptUpdatingHostBridge: HostBridge, @unchecked Sendable {
    let storage: HostStorageBackend = StubStorage()
    let coreStorage: HostCoreStorageBackend = StubCoreStorage()
    @MainActor weak var installation: ProductScriptInstallation?

    func navigateTo(url _: String) async throws {}
    func devicePermission(request _: HostDevicePermissionRequest) async throws -> Bool { false }
    func featureSupported(request _: HostFeatureSupportedRequest) async throws -> Bool { true }

    @MainActor
    func remotePermission(request: RemotePermission) async throws -> Bool {
        guard let installation else { return false }
        try await installation.setPermissionAuthorizationStatus(
            request: .remote(RemotePermissionRequest(permission: request)), status: .authorized
        )
        return true
    }
}

@MainActor
private final class ProductPageReady: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private var onReady: (() -> Void)?

    func load(_ webView: WKWebView, url: URL) async throws {
        let ready = AsyncStream<Void>.makeStream()
        onReady = {
            ready.continuation.yield(())
            ready.continuation.finish()
        }
        defer { onReady = nil }
        webView.load(URLRequest(url: url))
        try await withNetworkTestTimeout("page ready \(url.absoluteString)") {
            var iterator = ready.stream.makeAsyncIterator()
            guard await iterator.next() != nil else { throw CancellationError() }
        }
    }

    func userContentController(_: WKUserContentController, didReceive _: WKScriptMessage) {
        let callback = onReady
        onReady = nil
        callback?()
    }
}

private final class NetworkTestServer: @unchecked Sendable {
    private let listener: NWListener
    private let lock = NSLock()
    private var counts: [String: Int] = [:]

    private init(listener: NWListener) { self.listener = listener }

    @MainActor
    static func start() async throws -> NetworkTestServer {
        let server = NetworkTestServer(listener: try NWListener(using: .tcp, on: .any))
        server.listener.newConnectionHandler = { connection in server.accept(connection) }
        let ready = AsyncThrowingStream<Void, Error>.makeStream()
        server.listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.continuation.yield(())
                ready.continuation.finish()
            case let .failed(error):
                ready.continuation.finish(throwing: error)
            default: break
            }
        }
        server.listener.start(queue: DispatchQueue(label: "network-test-server"))
        do {
            try await withNetworkTestTimeout("loopback listener ready") {
                var iterator = ready.stream.makeAsyncIterator()
                guard try await iterator.next() != nil else { throw CancellationError() }
            }
        } catch {
            server.stop()
            throw error
        }
        server.listener.stateUpdateHandler = nil
        return server
    }

    func stop() {
        listener.newConnectionHandler = nil
        listener.cancel()
    }

    func url(host: String, path: String) -> URL {
        URL(string: "http://\(host):\(listener.port!.rawValue)\(path)")!
    }

    func requests(path: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return counts[path, default: 0]
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: DispatchQueue(label: "network-test-connection"))
        receiveRequest(connection, previous: Data())
    }

    private func receiveRequest(_ connection: NWConnection, previous: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
            guard let data, previous.count + data.count <= 65536 else {
                connection.cancel()
                return
            }
            let buffer = previous + data
            guard buffer.range(of: Data("\r\n\r\n".utf8)) != nil else {
                self.receiveRequest(connection, previous: buffer)
                return
            }
            guard let request = String(data: buffer, encoding: .utf8),
                  let path = request.split(separator: " ").dropFirst().first else {
                connection.cancel()
                return
            }
            self.lock.lock()
            self.counts[String(path), default: 0] += 1
            self.lock.unlock()
            var status = "200 OK"
            var headers = "Access-Control-Allow-Origin: *\r\nContent-Type: text/html\r\nCache-Control: no-store\r\n"
            var body = "allowed"
            if path == "/product" {
                body = "<script>window.webkit.messageHandlers.testReady.postMessage('ready')</script>"
            } else if path == "/redirect-denied" || path == "/redirect-revoked" {
                status = "302 Found"
                let destination = path == "/redirect-denied"
                    ? self.url(host: "[::1]", path: "/blocked")
                    : self.url(host: "127.0.0.1", path: "/allowed")
                headers += "Location: \(destination.absoluteString)\r\n"
                body = ""
            }
            let response = "HTTP/1.1 \(status)\r\n\(headers)Content-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}

#endif
