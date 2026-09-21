//! Browser bridge served to products during local development.

/// Path the bridge script is served from on the frame endpoint.
pub const PATH: &str = "/bootstrap.js";

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
}
