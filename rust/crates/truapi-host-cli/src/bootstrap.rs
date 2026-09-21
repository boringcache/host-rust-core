//! Browser bridge served to products during local development.

/// Path the bridge script is served from on the frame endpoint.
pub const PATH: &str = "/bootstrap.js";

/// JavaScript that connects a plain browser tab to this host's frame socket.
///
/// The page ends up with the same `window.__HOST_API_PORT__` a native webview
/// host injects, because it is the same script: [`truapi_server::bootstrap`]
/// renders it for every host. Products reference this from a development-only
/// `<script>` tag and need no other host-specific code.
///
/// The frame socket carries no session token, and a plain browser tab has no
/// lockdown container to read the WebRTC policy, so both are rendered empty and
/// permissive.
pub fn script(frame_url: &str) -> String {
    truapi_server::bootstrap::script(frame_url, "", true)
}

/// HTTP URL the bridge script is served from, for a frame endpoint that has
/// one. A private Unix socket is reachable only by the CLI's own product
/// runner, so it has no browser-facing address.
pub fn bridge_url(frame_url: &str) -> Option<String> {
    let authority = frame_url.strip_prefix("ws://")?;
    Some(format!("http://{authority}{PATH}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_url_is_offered_only_for_tcp_endpoints() {
        assert_eq!(
            bridge_url("ws://127.0.0.1:9955").as_deref(),
            Some("http://127.0.0.1:9955/bootstrap.js")
        );
        assert_eq!(bridge_url("ws+unix:/tmp/truapi/frames.sock"), None);
    }

    #[test]
    fn script_embeds_the_endpoint_as_a_string_literal() {
        let script = script("ws://127.0.0.1:9955");
        assert!(
            script.contains(r#"{ url: "ws://127.0.0.1:9955", token: "" }"#),
            "{script}"
        );
    }

    /// The endpoint reaches this from a command-line flag, so a quote in it
    /// must stay inside the literal rather than closing it and becoming code.
    #[test]
    fn script_escapes_an_endpoint_that_would_otherwise_break_out() {
        let script = script(r#"ws://x";alert(1);//"#);
        let declaration = script
            .lines()
            .find(|line| line.trim_start().starts_with("var endpoint ="))
            .expect("the script declares the endpoint");

        assert_eq!(
            declaration.trim(),
            r#"var endpoint = { url: "ws://x\";alert(1);//", token: "" };"#
        );
    }
}
