import Testing
import TrUAPIHost

/// The script's own behaviour is covered by `js/packages/truapi/src/bootstrap.test.ts`,
/// which runs the same source. These pin the wrapper: that it reaches the core's
/// renderer at all, and that the substitutions a host depends on still land.
struct LocalhostBridgeBootstrapTests {
    @Test
    func scriptCarriesTheEndpointTheTokenAndThePolicy() {
        let script = LocalhostBridgeBootstrap.script(port: 9955, token: "abc", webRtcAllowed: true)

        #expect(script.contains(#"{ url: "ws://127.0.0.1:9955/?t=abc", token: "abc" }"#))
        #expect(script.contains("window.__truapi_policy__ = { webRtcAllowed: true };"))
    }

    @Test
    func scriptRefusesWebRtcWhenTheHostDidNotGrantIt() {
        let script = LocalhostBridgeBootstrap.script(port: 1, token: "t", webRtcAllowed: false)

        #expect(script.contains("window.__truapi_policy__ = { webRtcAllowed: false };"))
    }

    /// Both platforms already evaluate these on app lifecycle. Without them the
    /// bridge only recovers once the dead socket reports itself, which a
    /// suspended content process may do late or not at all.
    @Test
    func scriptDefinesTheLifecycleHooksTheHostsAlreadyCall() {
        let script = LocalhostBridgeBootstrap.script(port: 1, token: "t", webRtcAllowed: false)

        #expect(script.contains("window.__pauseConnections__ ="))
        #expect(script.contains("window.__resumeConnections__ ="))
    }
}
