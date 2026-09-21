(function() {
  var endpoint = { url: __TRUAPI_BRIDGE_URL__, token: __TRUAPI_BRIDGE_TOKEN__ };

  if (window.__HOST_API_PORT__ || window.__truapi_localhost) return;

  var bridgeUrl = endpoint.url;

  var RETRY_BASE_MS = 250;
  // Keep retries within the SDK's 20s wait for a replacement port.
  var RETRY_MAX_MS = 5000;
  var VACANCY_POLL_MS = 50;
  // Stop polling when the SDK's 20s port wait has expired.
  var VACANCY_MAX_POLLS = 400;

  var live = null;
  var paused = false;
  var attempt = 0;
  var timer = null;
  var vacancyPolls = 0;

  // Each socket has its own core runtime, so frames and request ids cannot
  // move from a retired port to its replacement.
  function createConnection() {
    var socket = null;
    var started = false;
    var queue = [];
    var connection;

    var port = {
      onmessage: null,
      onmessageerror: null,

      postMessage: function(message) {
        if (!started) {
          port.start();
        }

        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(message);
        } else {
          queue.push(message);
        }
      },

      start: function() {
        if (started) return;
        started = true;

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
          attempt = 0;
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

        socket.onerror = function() {
          retire(connection);
        };

        socket.onclose = function() {
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
      retired: false,
      stale: function() {
        return socket !== null && socket.readyState >= WebSocket.CLOSING;
      }
    };

    return connection;
  }

  // The SDK uses onmessageerror as the port's close signal.
  function retire(connection) {
    if (connection.retired) return;
    connection.retired = true;
    if (live === connection) live = null;

    var notify = connection.port.onmessageerror;
    if (typeof notify === "function") {
      // SDK cleanup closes the socket and can re-enter retire.
      notify();
    }

    scheduleRepublish();
  }

  function scheduleRepublish() {
    if (paused || timer !== null) return;

    var delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, attempt));
    attempt += 1;
    timer = setTimeout(republish, delay);
  }

  function republish() {
    timer = null;
    if (paused || live !== null) return;

    // The SDK must release its old port before adopting a replacement.
    if (window.__HOST_API_PORT__ !== undefined) {
      if (vacancyPolls < VACANCY_MAX_POLLS) {
        vacancyPolls += 1;
        timer = setTimeout(republish, VACANCY_POLL_MS);
      }
      return;
    }

    publish();
  }

  function publish() {
    vacancyPolls = 0;
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
    attempt = 0;
    vacancyPolls = 0;

    if (live !== null) {
      if (live.stale()) {
        retire(live);
      }
      return;
    }

    if (timer !== null) {
      clearTimeout(timer);
    }
    republish();
  }

  window.__truapi_localhost = endpoint;
  window.__HOST_WEBVIEW_MARK__ = true;
  // Assigned once: a product may wrap these and chain to the original, so a
  // later reassignment would silently drop its handler.
  window.__pauseConnections__ = pause;
  window.__resumeConnections__ = resume;
  publish();
})();
