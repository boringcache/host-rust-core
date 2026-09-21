import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Recovery driven through the real SDK rather than a stand-in for it.
 *
 * `bootstrap.test.ts` models what the SDK does to a port it was handed. These
 * run the shipped script against the actual `sandbox.ts` and `transport.ts`, so
 * a wrong model of that handover fails here instead of passing everywhere and
 * breaking on a phone, and they repeat the cycle enough times to catch state
 * that only drifts after the first recovery.
 */
const SOURCE = readFileSync(
    new URL(
        "../../../../rust/crates/truapi-server/src/bootstrap/localhost-bridge.js",
        import.meta.url,
    ),
    "utf8",
);

const BRIDGE_URL = "ws://127.0.0.1:9955/?t=token";

/** Enough repetitions that a leak or a counter that never resets shows up. */
const CYCLES = 200;

let importCounter = 0;
async function importSandbox(): Promise<typeof import("./sandbox.js")> {
    importCounter += 1;
    return import(`./sandbox.ts?recovery=${importCounter}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let turn = 0; turn < 500 && !predicate(); turn += 1) await settle();
    if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

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

type BootstrapEntry = (
    window: unknown,
    webSocket: typeof FakeSocket,
    event: typeof Event,
    setTimeout: (handler: () => void, delay: number) => number,
    clearTimeout: (id: number) => void,
) => void;

/**
 * A top-level marked webview, the shape a native host presents, with the
 * shipped bootstrap already run against it. The bootstrap gets its own timer so
 * the backoff does not make the test wait; `sandbox.ts` keeps the real one.
 */
function installHost() {
    const sockets: FakeSocket[] = [];
    const delays: number[] = [];
    const timers = new Map<number, () => void>();
    let nextTimerId = 0;
    let refuseConnections = false;

    class TrackedSocket extends FakeSocket {
        constructor(url: string) {
            super(url);
            sockets.push(this);
            if (refuseConnections) {
                // A refused dial reaches the page as an error, never an open.
                queueMicrotask(() => this.close());
            }
        }
    }

    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const win = {
        location: {},
        addEventListener() {},
        removeEventListener() {},
        setInterval: () => 0,
        clearInterval() {},
        dispatchEvent: () => true,
    } as unknown as Window & typeof globalThis;
    (win as unknown as { top: unknown }).top = win;
    globalThis.window = win;
    globalThis.document = { referrer: "" } as Document;

    const source = SOURCE.replace("__TRUAPI_BRIDGE_URL__", JSON.stringify(BRIDGE_URL)).replace(
        "__TRUAPI_BRIDGE_TOKEN__",
        JSON.stringify("token"),
    );
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
            timers.set(nextTimerId, () => {
                timers.delete(nextTimerId);
                handler();
            });
            // Real asynchrony, no real wait: ordering still has to be right.
            queueMicrotask(() => timers.get(nextTimerId)?.());
            return nextTimerId;
        },
        (id) => {
            timers.delete(id);
        },
    );

    const hooks = win as unknown as {
        __HOST_API_PORT__?: unknown;
        __pauseConnections__: () => void;
        __resumeConnections__: () => void;
    };

    return {
        win,
        hooks,
        sockets,
        delays,
        pendingTimers: () => timers.size,
        refuse(value: boolean) {
            refuseConnections = value;
        },
        restore() {
            if (priorWindow === undefined) {
                delete (globalThis as { window?: unknown }).window;
            } else {
                globalThis.window = priorWindow;
            }
            if (priorDocument === undefined) {
                delete (globalThis as { document?: unknown }).document;
            } else {
                globalThis.document = priorDocument;
            }
        },
    };
}

let host: ReturnType<typeof installHost> | null = null;

afterEach(() => {
    host?.restore();
    host = null;
});

describe("bridge recovery through the real SDK", () => {
    /**
     * The reported failure is that a product never recovers, so one cycle only
     * proves the first recovery. Repeating it is what catches a port that is
     * published but never adopted, a backoff that never resets, or a timer or
     * socket that accumulates per cycle.
     */
    it("recovers a live client every time the socket dies", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        const statuses: string[] = [];
        sandbox.subscribeConnectionStatus((status) => statuses.push(status));

        const ports = new Set<unknown>();
        for (let cycle = 0; cycle < CYCLES; cycle += 1) {
            const client = sandbox.getClientSync();
            expect(client).not.toBeNull();

            await until(() => host!.sockets.length === cycle + 1, `socket ${cycle + 1}`);
            ports.add(host.win.__HOST_API_PORT__);
            const socket = host.sockets[cycle]!;
            socket.open();

            // A real request through the real transport: reaching the socket is
            // what proves this cycle's wire is carrying frames again. It never
            // answers, and the close below settles it.
            void Promise.resolve(client?.system.handshake()).then(
                () => {},
                () => {},
            );
            await until(() => socket.sent.length > 0, `a frame on socket ${cycle + 1}`);

            socket.close();
            await until(
                () => statuses.at(-1) === "disconnected",
                `the SDK to report cycle ${cycle + 1} closed`,
            );
        }

        expect({
            sockets: host.sockets.length,
            distinctPorts: ports.size,
            endpoints: new Set(host.sockets.map((socket) => socket.url)).size,
            everySocketCarriedAFrame: host.sockets.every((socket) => socket.sent.length > 0),
        }).toEqual({
            sockets: CYCLES,
            distinctPorts: CYCLES,
            endpoints: 1,
            everySocketCarriedAFrame: true,
        });
    });

    /**
     * Every cycle above ends in a successful open, so the backoff must return to
     * its floor each time. A delay that only ever grows would still pass a
     * single-recovery test and then sit at the 5s cap on a real device.
     */
    it("returns the backoff to its floor after each successful open", async () => {
        host = installHost();
        const sandbox = await importSandbox();

        for (let cycle = 0; cycle < 10; cycle += 1) {
            sandbox.getClientSync();
            await until(() => host!.sockets.length === cycle + 1, `socket ${cycle + 1}`);
            const socket = host.sockets[cycle]!;
            socket.open();
            socket.close();
            await settle();
        }

        expect(new Set(host.delays)).toEqual(new Set([250]));
    });

    /**
     * A bridge that stays down must neither spin nor give up: the delay climbs
     * to the cap, stays there, and the next open still recovers. The bootstrap
     * dials only when the SDK adopts the port it published, so the product
     * asking again is what drives each attempt.
     */
    it("climbs to the cap while the bridge refuses, then recovers", async () => {
        host = installHost();
        const sandbox = await importSandbox();

        sandbox.getClientSync();
        await until(() => host.sockets.length === 1, "the first socket");
        host.sockets[0]!.open();
        host.refuse(true);
        host.sockets[0]!.close();

        for (let turn = 0; turn < 400 && host.delays.length < 8; turn += 1) {
            sandbox.getClientSync();
            await settle();
        }
        expect(host.delays.length).toBeGreaterThanOrEqual(8);

        host.refuse(false);
        const beforeRecovery = host.sockets.length;
        for (let turn = 0; turn < 400 && host.sockets.length === beforeRecovery; turn += 1) {
            sandbox.getClientSync();
            await settle();
        }
        const recovered = host.sockets[host.sockets.length - 1]!;
        recovered.open();

        expect({
            climbed: host.delays.slice(0, 6),
            cappedAfterwards: host.delays.slice(6).every((delay) => delay === 5000),
            recoveredOpen: recovered.readyState,
        }).toEqual({
            climbed: [250, 500, 1000, 2000, 4000, 5000],
            cappedAfterwards: true,
            recoveredOpen: FakeSocket.OPEN,
        });
    });

    /**
     * The reported sequence: the socket dies while the app is backgrounded, so
     * the host has already paused the page and no redial may be scheduled
     * behind its back. Recovery has to come from the resume hook the host calls
     * on the way back, and the product's next host call has to land.
     */
    it("recovers when the socket dies while the host has the page paused", async () => {
        host = installHost();
        const sandbox = await importSandbox();

        sandbox.getClientSync();
        await until(() => host.sockets.length === 1, "the first socket");
        host.sockets[0]!.open();

        host.hooks.__pauseConnections__();
        host.sockets[0]!.close();
        await settle();
        const whilePaused = {
            port: host.hooks.__HOST_API_PORT__,
            sockets: host.sockets.length,
        };

        host.hooks.__resumeConnections__();
        const client = sandbox.getClientSync();
        await until(() => host.sockets.length === 2, "a socket after the host resumed");
        host.sockets[1]!.open();
        void Promise.resolve(client?.system.handshake()).then(
            () => {},
            () => {},
        );
        await until(() => host.sockets[1]!.sent.length > 0, "a frame after the host resumed");

        expect(whilePaused).toEqual({ port: undefined, sockets: 1 });
    });

    /** A recovered page must not be left holding timers that keep firing. */
    it("leaves no pending timer once the bridge is healthy again", async () => {
        host = installHost();
        const sandbox = await importSandbox();

        sandbox.getClientSync();
        await until(() => host.sockets.length === 1, "the first socket");
        host.sockets[0]!.open();
        host.sockets[0]!.close();

        sandbox.getClientSync();
        await until(() => host.sockets.length === 2, "the replacement socket");
        host.sockets[1]!.open();
        await settle();

        expect(host.pendingTimers()).toBe(0);
    });
});
