// ============================================================================
// TrUAPI mode lockdown. Runs AFTER LocalhostBridgeBootstrap (native injects
// the bootstrap first), which publishes window.__truapi_localhost and
// __HOST_WEBVIEW_MARK__.
// Product connections open only when used, so
// window.WebSocket must remain constructible for exactly the bridge URL.
//
// Hosts must inject this script into EVERY frame, not just the main frame. A
// realm without it has pristine fetch/WebSocket/RTCPeerConnection, and a
// product can reach one through any iframe path that skips
// `document.createElement` (innerHTML, document.write, createElementNS,
// srcdoc). Only the bootstrap is main-frame-only: a subframe with no bridge
// endpoint fails closed on every gate below.
// ============================================================================

// =============================================================================
// Isolation: Lock down globals so product scripts cannot access platform APIs.
// =============================================================================

import { installContainer } from './container.js';

installContainer();
