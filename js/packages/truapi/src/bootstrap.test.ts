import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
    new URL(
        "../../../../rust/crates/truapi-server/src/bootstrap/localhost-bridge.js",
        import.meta.url,
    ),
    "utf8",
);

const BRIDGE_URL = "ws://127.0.0.1:9955/?t=token";

interface HostPort {
    onmessage: ((event: { data: Uint8Array }) => void) | null;
    onmessageerror: (() => void) | null;
    postMessage(message: Uint8Array): void;
    start(): void;
    close(): void;
}

interface BootstrapWindow {
    __HOST_API_PORT__?: HostPort;
    __HOST_WEBVIEW_MARK__?: boolean;
    __truapi_localhost?: { url: string; token: string };
    __pauseConnections__?: () => void;
    __resumeConnections__?: () => void;
    dispatchEvent(event: { type: string }): boolean;
}

type BootstrapEntry = (
    window: BootstrapWindow,
    webSocket: typeof FakeSocket,
    event: typeof Event,
    setTimeout: (handler: () => void, delay: number) => number,
    clearTimeout: (id: number) => void,
) => void;

class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    binaryType = "";
    readyState: number = FakeSocket.CONNECTING;
    readonly sent: Uint8Array[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(readonly url: string) {}

    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.onopen?.();
    }

    send(frame: Uint8Array): void {
        this.sent.push(frame);
    }

    close(): void {
        if (this.readyState === FakeSocket.CLOSED) return;
        this.readyState = FakeSocket.CLOSED;
        this.onclose?.();
    }
}

function installBootstrap(existingPort?: HostPort) {
    const source = SOURCE.replace("__TRUAPI_BRIDGE_URL__", JSON.stringify(BRIDGE_URL))
        .replace("__TRUAPI_BRIDGE_TOKEN__", JSON.stringify("token"));

    const sockets: FakeSocket[] = [];
    const readyEvents: string[] = [];
    const delays: number[] = [];
    const timers = new Map<number, () => void>();
    let nextTimerId = 0;

    class TrackedSocket extends FakeSocket {
        constructor(url: string) {
            super(url);
            sockets.push(this);
        }
    }

    const win: BootstrapWindow = {
        __HOST_API_PORT__: existingPort,
        dispatchEvent(event) {
            readyEvents.push(event.type);
            return true;
        },
    };

    const entry = new Function(
        "window",
        "WebSocket",
        "Event",
        "setTimeout",
        "clearTimeout",
        source,
    ) as unknown as BootstrapEntry;

    entry(
        win,
        TrackedSocket,
        Event,
        (handler, delay) => {
            nextTimerId += 1;
            delays.push(delay);
            timers.set(nextTimerId, handler);
            return nextTimerId;
        },
        (id) => {
            timers.delete(id);
        },
    );

    return {
        win,
        sockets,
        readyEvents,
        delays,

        advance(): void {
            const due = [...timers.values()];
            timers.clear();
            for (const run of due) run();
        },

        // SDK cleanup closes the port before clearing its global reference.
        adopt(received: Uint8Array[] = []): HostPort {
            const port = win.__HOST_API_PORT__;
            if (!port) throw new Error("the bootstrap published no port");
            port.onmessage = (event) => received.push(event.data);
            port.onmessageerror = () => {
                port.close();
                delete win.__HOST_API_PORT__;
            };
            port.start();
            return port;
        },
    };
}

describe("localhost bridge bootstrap", () => {
    it("preserves a port supplied by another host", () => {
        const original = installBootstrap();
        const port = original.win.__HOST_API_PORT__;
        const host = installBootstrap(port);

        expect({
            port: host.win.__HOST_API_PORT__,
            endpoint: host.win.__truapi_localhost,
            events: host.readyEvents,
        }).toEqual({ port, endpoint: undefined, events: [] });
    });

    it("preserves queued requests when resuming before the socket opens", () => {
        const host = installBootstrap();
        const port = host.adopt();
        port.postMessage(Uint8Array.of(1, 2, 3));

        host.win.__pauseConnections__?.();
        host.win.__resumeConnections__?.();
        host.sockets[0]!.open();

        expect({
            port: host.win.__HOST_API_PORT__,
            sent: host.sockets[0]!.sent,
            events: host.readyEvents,
        }).toEqual({
            port,
            sent: [Uint8Array.of(1, 2, 3)],
            events: ["truapi-native-ready"],
        });
    });

    it("publishes the endpoint and the webview mark at document start", () => {
        const host = installBootstrap();

        expect({
            endpoint: host.win.__truapi_localhost,
            mark: host.win.__HOST_WEBVIEW_MARK__,
            published: host.win.__HOST_API_PORT__ !== undefined,
            events: host.readyEvents,
        }).toEqual({
            endpoint: { url: BRIDGE_URL, token: "token" },
            mark: true,
            published: true,
            events: ["truapi-native-ready"],
        });
    });

    it("dials the endpoint verbatim, because the container gates WebSocket on that exact string", () => {
        const host = installBootstrap();

        host.adopt();

        expect(host.sockets.map((socket) => socket.url)).toEqual([BRIDGE_URL]);
    });

    /**
     * The failure behind platform-issues#3: an iOS background kills the loopback
     * socket, the SDK drops the port it was handed, and without a replacement
     * every later host call fails for the lifetime of the page.
     */
    it("publishes a fresh port once the SDK has dropped the closed one", () => {
        const host = installBootstrap();
        const first = host.adopt();
        host.sockets[0]!.open();

        host.sockets[0]!.close();
        host.advance();

        expect({
            published: host.win.__HOST_API_PORT__ !== undefined,
            replaced: host.win.__HOST_API_PORT__ !== first,
            readyAnnounced: host.readyEvents,
        }).toEqual({
            published: true,
            replaced: true,
            readyAnnounced: ["truapi-native-ready", "truapi-native-ready"],
        });
    });

    /**
     * An SDK that could not delete the global still holds the dead port. Writing
     * over it would hand that SDK a port it has already refused, and the close it
     * reported would never reach a second reader.
     */
    it("does not publish over a port the SDK still holds", () => {
        const host = installBootstrap();
        const first = host.win.__HOST_API_PORT__;
        if (!first) throw new Error("the bootstrap published no port");
        first.onmessageerror = () => {};
        first.start();
        host.sockets[0]!.open();

        host.sockets[0]!.close();
        host.advance();

        expect(host.win.__HOST_API_PORT__).toBe(first);
    });

    /**
     * Each port owns one socket for its whole life, because the core builds one
     * `ProductRuntime` per connection. A retired port that could still reach the
     * live socket would tear down the runtime its successor is talking to.
     */
    it("keeps a retired port's close away from the live socket", () => {
        const host = installBootstrap();
        const retired = host.adopt();
        host.sockets[0]!.open();
        host.sockets[0]!.close();
        host.advance();
        const current = host.adopt();
        host.sockets[1]!.open();

        retired.close();
        host.sockets[0]!.onerror?.();
        host.sockets[0]!.onclose?.();
        host.advance();
        current.postMessage(Uint8Array.of(7));

        expect({
            port: host.win.__HOST_API_PORT__,
            liveState: host.sockets[1]!.readyState,
            delivered: host.sockets[1]!.sent,
        }).toEqual({
            port: current,
            liveState: FakeSocket.OPEN,
            delivered: [Uint8Array.of(7)],
        });
    });

    /** A bridge that stays down must not become a dial storm. */
    it("backs off between attempts and caps the delay under the SDK's port wait", () => {
        const host = installBootstrap();
        host.adopt();
        host.sockets[0]!.open();
        host.sockets[0]!.close();

        for (let attempt = 0; attempt < 7; attempt += 1) {
            host.advance();
            host.adopt();
            host.sockets[host.sockets.length - 1]!.close();
        }

        expect(host.delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
    });

    it("redials on resume without waiting out the backoff, and stays down while paused", () => {
        const host = installBootstrap();
        host.adopt();
        host.sockets[0]!.open();

        host.win.__pauseConnections__?.();
        host.sockets[0]!.close();
        host.advance();
        const whilePaused = host.win.__HOST_API_PORT__;

        host.win.__resumeConnections__?.();

        expect({
            whilePaused,
            afterResume: host.win.__HOST_API_PORT__ !== undefined,
        }).toEqual({ whilePaused: undefined, afterResume: true });
    });

    /**
     * Products wrap the resume hook and chain to the original, so re-assigning it
     * on a later republish would silently drop their handler.
     */
    it("defines the lifecycle hooks once, so a product's wrapper survives a redial", () => {
        const host = installBootstrap();
        const original = host.win.__resumeConnections__;
        let wrapperCalls = 0;
        host.win.__resumeConnections__ = () => {
            wrapperCalls += 1;
            original?.();
        };

        host.adopt();
        host.sockets[0]!.open();
        host.sockets[0]!.close();
        host.advance();
        host.win.__resumeConnections__();

        expect(wrapperCalls).toBe(1);
    });
});
