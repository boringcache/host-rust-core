(function() {
  var endpoint = { url: __TRUAPI_BRIDGE_URL__, token: __TRUAPI_BRIDGE_TOKEN__ };

  if (window.__HOST_API_PORT__ || window.__truapi_localhost) return;

  var bridgeUrl = endpoint.url;

  var RETRY_BASE_MS = 250;
  // Keep retries within the SDK's 20s wait for a replacement port.
  var RETRY_MAX_MS = 5000;

  var live = null;
  var paused = false;
  var retryDelay = RETRY_BASE_MS;
  var timer = null;

  // Each socket has its own core runtime, so frames and request ids cannot
  // move from a retired port to its replacement.
  function createConnection() {
    var socket = null;
    var queue = [];
    var connection;

    var port = {
      onmessage: null,
      onmessageerror: null,

      postMessage: function(message) {
        port.start();

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(message);
        } else {
          queue.push(message);
        }
      },

      start: function() {
        if (socket !== null || live !== connection) return;

        try {
          // Product code can mutate endpoint.url; the container only admits
          // the original URL.
          socket = new WebSocket(bridgeUrl);
        } catch {
          retire(connection);
          return;
        }
        socket.binaryType = "arraybuffer";

        socket.onopen = function() {
          retryDelay = RETRY_BASE_MS;
          var pending = queue;
          queue = [];
          pending.forEach(function(message) {
            socket.send(message);
          });
        };

        socket.onmessage = function(event) {
          if (typeof port.onmessage === "function") {
            port.onmessage({ data: new Uint8Array(event.data) });
          }
        };

        socket.onerror = socket.onclose = function() {
          retire(connection);
        };
      },

      close: function() {
        queue = [];
        if (socket) {
          socket.close();
        }
      }
    };

    connection = {
      port: port,
      stale: function() {
        return socket !== null && socket.readyState >= WebSocket.CLOSING;
      }
    };

    return connection;
  }

  // The SDK uses onmessageerror as the port's close signal.
  function retire(connection) {
    if (live !== connection) return;
    live = null;

    var notify = connection.port.onmessageerror;
    if (typeof notify === "function") {
      // SDK cleanup closes the socket and can re-enter retire.
      notify();
    }

    if (paused || timer !== null) return;
    timer = setTimeout(publish, retryDelay);
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  }

  function publish() {
    timer = null;
    if (paused || live !== null || window.__HOST_API_PORT__) return;

    live = createConnection();
    window.__HOST_API_PORT__ = live.port;
    window.dispatchEvent(new Event('truapi-native-ready'));
  }

  // Hosts call these on app lifecycle. Pausing is not a teardown: Android also
  // fires it on transient UI events, and closing a healthy socket there would
  // orphan a product runtime every time a sheet is dismissed.
  function pause() {
    paused = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function resume() {
    paused = false;
    retryDelay = RETRY_BASE_MS;

    if (live !== null) {
      if (live.stale()) {
        retire(live);
      }
      return;
    }

    if (timer !== null) {
      clearTimeout(timer);
    }
    publish();
  }

  window.__truapi_localhost = endpoint;
  window.__HOST_WEBVIEW_MARK__ = true;
  // Assigned once: a product may wrap these and chain to the original, so a
  // later reassignment would silently drop its handler.
  window.__pauseConnections__ = pause;
  window.__resumeConnections__ = resume;
  publish();
})();
