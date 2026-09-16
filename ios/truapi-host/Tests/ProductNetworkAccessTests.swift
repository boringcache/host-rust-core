#if canImport(WebKit)

import Foundation
import Network
import Testing
import WebKit
@testable import TrUAPIHost

@Suite(.serialized)
@MainActor
struct ProductNetworkAccessTests {
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
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(ready, name: "testReady")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let productURL = server.url(host: "localhost", path: "/product")
        let installation = try await TrUAPIHost.installProductScripts(
            into: webView, execution: execution,
            endpoint: execution.startWsBridge(bindPort: 0), productURL: productURL
        )
        bridge.installation = installation
        defer { installation.dispose() }
        await withCheckedContinuation { continuation in
            ready.onReady = { continuation.resume() }
            webView.load(URLRequest(url: productURL))
        }

        #expect(await fetch(webView, server.url(host: "127.0.0.1", path: "/allowed")) == "allowed")
        #expect(server.requests(path: "/allowed") == 1)
    }

    @Test(.timeLimit(.minutes(1)))
    func grantedFetchUsesTheRustDecisionAndRevocationBlocksRedirects() async throws {
        let server = try await NetworkTestServer.start()
        defer { server.stop() }
        for hostname in ["localhost", "127.0.0.1", "[::1]"] {
            let (_, response) = try await URLSession.shared.data(from: server.url(host: hostname, path: "/probe"))
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
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
        let occupiedConfiguration = WKWebViewConfiguration()
        occupiedConfiguration.websiteDataStore = .nonPersistent()
        let occupiedView = WKWebView(frame: .zero, configuration: occupiedConfiguration)
        occupiedView.navigationDelegate = ready
        await #expect(throws: ProductScriptInstallationError.navigationDelegateAlreadyInstalled) {
            try await TrUAPIHost.installProductScripts(
                into: occupiedView, execution: execution, endpoint: endpoint, productURL: productURL
            )
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(ready, name: "testReady")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let installation = try await TrUAPIHost.installProductScripts(
            into: webView, execution: execution, endpoint: endpoint, productURL: productURL
        )
        defer { installation.dispose() }
        await withCheckedContinuation { continuation in
            ready.onReady = { continuation.resume() }
            webView.load(URLRequest(url: productURL))
        }
        await #expect(throws: ProductScriptInstallationError.webViewAlreadyLoaded) {
            try await TrUAPIHost.installProductScripts(
                into: webView, execution: execution, endpoint: endpoint, productURL: productURL
            )
        }

        let remote = server.url(host: "127.0.0.1", path: "/allowed")
        #expect(await fetch(webView, remote) == "denied")
        #expect(server.requests(path: "/allowed") == 0)

        let permission = PermissionAuthorizationRequest.remote(
            RemotePermissionRequest(permission: .remote(domains: ["127.0.0.1"]))
        )
        try await installation.setPermissionAuthorizationStatus(request: permission, status: .authorized)
        #expect(await fetch(webView, remote) == "allowed")
        #expect(server.requests(path: "/allowed") == 1)

        let redirect = server.url(host: "127.0.0.1", path: "/redirect-denied")
        #expect(await fetch(webView, redirect) == "denied")
        #expect(server.requests(path: "/blocked") == 0)

        try await installation.setPermissionAuthorizationStatus(
            request: .remote(RemotePermissionRequest(permission: .remote(domains: ["[::1]"]))),
            status: .authorized
        )
        #expect(await fetch(webView, redirect) == "denied")
        #expect(server.requests(path: "/blocked") == 0)

        let secondExecution = try runtime.openProductExecution(
            bridge: bridge,
            configuration: ProductExecutionConfig(productId: "network.paseo", executionKind: .app)
        )
        defer { secondExecution.close() }
        let secondReady = ProductPageReady()
        let secondConfiguration = WKWebViewConfiguration()
        secondConfiguration.websiteDataStore = .nonPersistent()
        secondConfiguration.userContentController.add(secondReady, name: "testReady")
        let secondWebView = WKWebView(frame: .zero, configuration: secondConfiguration)
        let secondInstallation = try await TrUAPIHost.installProductScripts(
            into: secondWebView, execution: secondExecution,
            endpoint: secondExecution.startWsBridge(bindPort: 0), productURL: productURL
        )
        defer { secondInstallation.dispose() }
        await withCheckedContinuation { continuation in
            secondReady.onReady = { continuation.resume() }
            secondWebView.load(URLRequest(url: productURL))
        }
        #expect(await fetch(secondWebView, remote) == "allowed")
        #expect(server.requests(path: "/allowed") == 2)

        try await installation.setPermissionAuthorizationStatus(request: permission, status: .denied)
        let productRedirect = server.url(host: "localhost", path: "/redirect-revoked")
        #expect(await fetch(webView, productRedirect) == "denied")
        #expect(server.requests(path: "/allowed") == 2)
        let preload = try await secondWebView.callAsyncJavaScript("""
            return await new Promise(resolve => {
              const link = document.createElement('link');
              link.rel = 'preload'; link.as = 'fetch'; link.crossOrigin = 'anonymous';
              link.onload = () => resolve('loaded'); link.onerror = () => resolve('blocked');
              link.href = url; document.head.appendChild(link);
            });
            """, arguments: ["url": remote.absoluteString], in: nil, contentWorld: .page)
        #expect(preload as? String == "blocked")
        #expect(server.requests(path: "/allowed") == 2)

        installation.dispose()
        #expect(await fetch(webView, remote) == "denied")
        #expect(server.requests(path: "/allowed") == 2)
    }

    @Test
    func networkRulesDoNotBroadenOriginsOrBridgeCredentials() throws {
        let product = try ProductNetworkOrigin(URL(string: "polkadot://example.paseo/index.html")!)
        let remote = try ProductNetworkOrigin(URL(string: "https://api.example.com:8443/data")!)
        let bridge = "ws://127.0.0.1:1234/?t=exact-token"
        let rules = try ProductNetworkRules.encode(
            productOrigin: product, bridgeURL: bridge, remoteOrigins: [remote]
        )
        let decoded = try #require(JSONSerialization.jsonObject(with: Data(rules.utf8)) as? [[String: Any]])
        #expect(decoded.count == 4)
        let remoteTrigger = try #require(decoded[3]["trigger"] as? [String: Any])
        #expect(remoteTrigger["resource-type"] as? [String] == ["raw"])
        let remotePattern = try #require(remoteTrigger["url-filter"] as? String)
        #expect(matches(remotePattern, "https://api.example.com:8443/data"))
        #expect(!matches(remotePattern, "https://api.example.com.attacker.test:8443/data"))
        #expect(!matches(remotePattern, "https://api.example.com:443/data"))
        let bridgeTrigger = try #require(decoded[2]["trigger"] as? [String: Any])
        let bridgePattern = try #require(bridgeTrigger["url-filter"] as? String)
        #expect(matches(bridgePattern, bridge))
        #expect(!matches(bridgePattern, bridge + "-other"))
    }

    private func fetch(_ webView: WKWebView, _ url: URL) async -> String {
        (try? await webView.callAsyncJavaScript(
            "try { const response = await fetch(url); return await response.text(); } catch { return 'denied'; }",
            arguments: ["url": url.absoluteString], in: nil, contentWorld: .page
        )) as? String ?? "evaluation failed"
    }

    private func matches(_ pattern: String, _ value: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}

private final class PromptUpdatingHostBridge: HostBridge, @unchecked Sendable {
    let storage: HostStorageBackend = StubStorage()
    let coreStorage: HostCoreStorageBackend = NetworkTestCoreStorage()
    @MainActor weak var installation: ProductScriptInstallation?

    func navigateTo(url _: String) async throws {}
    func devicePermission(request _: HostDevicePermissionRequest) async throws -> Bool { false }
    func featureSupported(request _: HostFeatureSupportedRequest) async throws -> Bool { true }

    func remotePermission(request: RemotePermission) async throws -> Bool {
        try await updatePermission(request)
    }

    @MainActor
    private func updatePermission(_ request: RemotePermission) async throws -> Bool {
        guard let installation else { return false }
        try await installation.setPermissionAuthorizationStatus(
            request: .remote(RemotePermissionRequest(permission: request)), status: .authorized
        )
        return true
    }
}

private final class NetworkTestCoreStorage: HostCoreStorageBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Data: Data] = [:]

    func read(key: Data) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    func write(key: Data, value: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }

    func clear(key: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        values[key] = nil
    }
}

@MainActor
private final class ProductPageReady: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var onReady: (() -> Void)?

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

    static func start() async throws -> NetworkTestServer {
        let server = NetworkTestServer(listener: try NWListener(using: .tcp, on: .any))
        server.listener.newConnectionHandler = { connection in server.accept(connection) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            server.listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    server.listener.stateUpdateHandler = nil
                    continuation.resume()
                case let .failed(error):
                    server.listener.stateUpdateHandler = nil
                    continuation.resume(throwing: error)
                default: break
                }
            }
            server.listener.start(queue: DispatchQueue(label: "network-test-server"))
        }
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
