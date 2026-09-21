//! Browser bridge script a host injects into a product's web view.
//!
//! One JavaScript source backs every host. The iOS and Android bindings render
//! it through their `LocalhostBridgeBootstrap` wrappers and the development CLI
//! serves it from its frame endpoint, so the page ends up with the
//! `window.__HOST_API_PORT__` the SDK's sandbox bootstrap adopts and a product
//! needs no host-specific code.

/// The single JavaScript source every host renders.
const SOURCE: &str = include_str!("bootstrap/localhost-bridge.js");

/// Stands in for the complete string literal holding the frame endpoint.
const URL_PLACEHOLDER: &str = "__TRUAPI_BRIDGE_URL__";

/// Stands in for the complete string literal holding the session token.
const TOKEN_PLACEHOLDER: &str = "__TRUAPI_BRIDGE_TOKEN__";

/// Stands in for the `true` or `false` the container reads as its WebRTC policy.
const WEB_RTC_PLACEHOLDER: &str = "__TRUAPI_WEBRTC_ALLOWED__";

/// Render the bridge script for one product execution.
///
/// `web_rtc_allowed` must come from a permission peek, never a prompt. The
/// container enforces it inside the product's own realm, where an asynchronous
/// request would be forgeable: product script can hook the primitives such a
/// request's bookkeeping relies on and resolve it itself. A settled value has
/// nothing to steal, and the consequence is that a fresh grant only takes
/// effect once the web view reloads.
pub fn script(url: &str, token: &str, web_rtc_allowed: bool) -> String {
    SOURCE
        .replace(URL_PLACEHOLDER, &js_string_literal(url))
        .replace(TOKEN_PLACEHOLDER, &js_string_literal(token))
        .replace(
            WEB_RTC_PLACEHOLDER,
            if web_rtc_allowed { "true" } else { "false" },
        )
}

/// Encode `value` as a complete double-quoted JavaScript string literal, safe
/// to embed inside a `<script>` body. JSON escaping covers quotes, backslashes
/// and control characters; U+2028 and U+2029 are escaped explicitly because
/// JSON leaves them raw while JavaScript treats them as line terminators.
fn js_string_literal(value: &str) -> String {
    serde_json::to_string(value)
        .expect("a string always serializes")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_line(script: &str, needle: &str) -> String {
        script
            .lines()
            .find(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("the script declares {needle}"))
            .trim()
            .to_owned()
    }

    #[test]
    fn script_carries_the_endpoint_and_the_webrtc_policy() {
        let script = script("ws://127.0.0.1:9955/?t=abc", "abc", true);

        assert_eq!(
            (
                config_line(&script, "var endpoint ="),
                config_line(&script, "__truapi_policy__"),
            ),
            (
                r#"var endpoint = { url: "ws://127.0.0.1:9955/?t=abc", token: "abc" };"#.to_owned(),
                "window.__truapi_policy__ = { webRtcAllowed: true };".to_owned(),
            )
        );
    }

    /// The endpoint reaches this from a command-line flag, so a quote in it
    /// must stay inside the literal rather than closing it and becoming code.
    #[test]
    fn script_escapes_an_endpoint_that_would_otherwise_break_out() {
        let script = script(r#"ws://x";alert(1);//"#, "", false);

        assert_eq!(
            config_line(&script, "var endpoint ="),
            r#"var endpoint = { url: "ws://x\";alert(1);//", token: "" };"#
        );
    }

    /// A line terminator JSON leaves raw would end the statement it sits in.
    #[test]
    fn script_escapes_the_line_terminators_json_leaves_raw() {
        let line_separator = char::from_u32(0x2028).expect("U+2028 is a scalar value");
        let escape = format!("{}u2028", '\\');

        let script = script(&format!("ws://x{line_separator}y"), "", false);

        assert_eq!(
            config_line(&script, "var endpoint ="),
            format!(r#"var endpoint = {{ url: "ws://x{escape}y", token: "" }};"#)
        );
    }
}
