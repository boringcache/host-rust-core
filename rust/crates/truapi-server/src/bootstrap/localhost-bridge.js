(function() {
  if (window.__HOST_API_PORT__ || window.__truapi_localhost) return;

  var endpoint = { url: __TRUAPI_BRIDGE_URL__, token: __TRUAPI_BRIDGE_TOKEN__ };
  window.__truapi_localhost = endpoint;
  window.__HOST_WEBVIEW_MARK__ = true;
  window.dispatchEvent(new Event('truapi-native-ready'));
})();
