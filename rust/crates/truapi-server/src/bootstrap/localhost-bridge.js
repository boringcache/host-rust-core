(function() {
  var endpoint = { url: __TRUAPI_BRIDGE_URL__, token: __TRUAPI_BRIDGE_TOKEN__ };

  // A second injection would install a manager competing with the live one.
  if (window.__truapi_localhost) return;

  var bridgeUrl = endpoint.url;

  var RETRY_BASE_MS = 250;
  // Under the SDK's 20s wait for a port, so a rebuild already in progress
  // always finds one before it gives up.
  var RETRY_MAX_MS = 5000;
  var VACANCY_POLL_MS = 50;
  // 20s of polling, which is how long the SDK itself waits for a port. Past
  // that the rebuild we would be publishing for has already given up.
  var VACANCY_MAX_POLLS = 400;

  var live = null;
  var paused = false;
  var attempt = 0;
  var timer = null;
  var vacancyPolls = 0;

  // The core builds one product runtime per connection, so a port owns its
  // socket for life: a reconnect publishes a new port rather than redialling
  // under the old one, whose queued frames and request ids belong to a runtime
  // that no longer exists.
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
          // The captured URL, not `endpoint.url`: the endpoint object is
          // reachable from product script, and the container admits exactly
          // the string it read at load time.
          socket = new WebSocket(bridgeUrl);
        } catch (error) {
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
        return started && (socket === null || socket.readyState !== WebSocket.OPEN);
      }
    };

    return connection;
  }

  // The SDK reports a dead pipe through `onmessageerror`; a real MessagePort
  // never fires it for that reason, but it is the only close channel a port
  // has and every shipped product already listens on it.
  function retire(connection) {
    if (connection.retired) return;
    connection.retired = true;
    if (live === connection) live = null;

    var notify = connection.port.onmessageerror;
    if (typeof notify === "function") {
      // Re-entrant: the SDK's cleanup closes this port, which closes this
      // socket again. The flag above is what stops that recursing.
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

    // An SDK that could not drop the port it refused still holds it. Writing
    // over it would hand that same SDK a port it has already rejected, so wait
    // for the vacancy instead.
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
  window.__truapi_policy__ = { webRtcAllowed: __TRUAPI_WEBRTC_ALLOWED__ };
  window.__HOST_WEBVIEW_MARK__ = true;
  // Assigned once: a product may wrap these and chain to the original, so a
  // later reassignment would silently drop its handler.
  window.__pauseConnections__ = pause;
  window.__resumeConnections__ = resume;
  publish();
})();
