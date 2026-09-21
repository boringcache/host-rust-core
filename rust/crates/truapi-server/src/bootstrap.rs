//! Shared browser bootstrap for native hosts and the development CLI.

const SOURCE: &str = include_str!("bootstrap/localhost-bridge.js");
const URL_PLACEHOLDER: &str = "__TRUAPI_BRIDGE_URL__";
const TOKEN_PLACEHOLDER: &str = "__TRUAPI_BRIDGE_TOKEN__";

/// Render the bridge script for one product execution.
pub fn script(url: &str, token: &str) -> String {
    SOURCE
        .replace(URL_PLACEHOLDER, &js_string_literal(url))
        .replace(TOKEN_PLACEHOLDER, &js_string_literal(token))
}

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
    fn script_carries_the_endpoint() {
        let script = script("ws://127.0.0.1:9955/?t=abc", "abc");

        assert_eq!(
            config_line(&script, "var endpoint ="),
            r#"var endpoint = { url: "ws://127.0.0.1:9955/?t=abc", token: "abc" };"#
        );
    }

    #[test]
    fn script_escapes_an_endpoint_that_would_otherwise_break_out() {
        let script = script(r#"ws://x";alert(1);//"#, "");

        assert_eq!(
            config_line(&script, "var endpoint ="),
            r#"var endpoint = { url: "ws://x\";alert(1);//", token: "" };"#
        );
    }

    #[test]
    fn script_escapes_the_line_terminators_json_leaves_raw() {
        let script = script("ws://x\u{2028}y\u{2029}z", "");

        assert_eq!(
            config_line(&script, "var endpoint ="),
            r#"var endpoint = { url: "ws://x\u2028y\u2029z", token: "" };"#
        );
    }
}
