import Testing
import TrUAPIHost

struct LocalhostBridgeBootstrapTests {
    @Test
    func scriptCarriesTheEndpointAndToken() {
        let script = LocalhostBridgeBootstrap.script(port: 9955, token: "abc")

        #expect(script.contains(#"{ url: "ws://127.0.0.1:9955/?t=abc", token: "abc" }"#))
    }

    @Test
    func scriptDefinesTheLifecycleHooksTheHostsCall() {
        let script = LocalhostBridgeBootstrap.script(port: 1, token: "t")

        #expect(script.contains("window.__pauseConnections__ ="))
        #expect(script.contains("window.__resumeConnections__ ="))
    }
}
