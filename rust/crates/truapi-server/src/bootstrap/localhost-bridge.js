(function() {
  if (window.__HOST_API_PORT__ || window.__truapi_localhost) return;

  var endpoint = { url: __TRUAPI_BRIDGE_URL__, token: __TRUAPI_BRIDGE_TOKEN__ };
  var bridgeUrl = endpoint.url;
  var socket = null;
  var pending = [];
  var closed = false;

  var port = {
    onmessage: null,
    onmessageerror: null,
    postMessage: function(message) {
      if (closed) return;
      port.start();
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(message);
    },
    start: function() {
      if (socket || closed) return;
      try {
        socket = new WebSocket(bridgeUrl);
      } catch (error) {
        port.close();
        throw error;
      }
      socket.binaryType = 'arraybuffer';
      socket.onopen = function() {
        pending.forEach(function(message) {
          socket.send(message);
        });
        pending.length = 0;
      };
      socket.onmessage = function(event) {
        if (!closed && port.onmessage) {
          port.onmessage({ data: new Uint8Array(event.data) });
        }
      };
      socket.onerror = socket.onclose = function() {
        if (closed) return;
        port.close();
        if (port.onmessageerror) port.onmessageerror();
      };
    },
    close: function() {
      if (closed) return;
      closed = true;
      pending.length = 0;
      if (socket) socket.close();
    }
  };

  window.__HOST_API_PORT__ = port;
  window.__truapi_localhost = endpoint;
  window.__HOST_WEBVIEW_MARK__ = true;
  window.dispatchEvent(new Event('truapi-native-ready'));
})();
