import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { TrUApiClient } from "./generated/index.js";
import * as T from "./generated/types.js";
import * as S from "./scale.js";
import { decodeWireMessage, encodeWireMessage, MESSAGE_TYPE_RESPONSE } from "./transport.js";

const SOURCE = readFileSync(
    new URL(
        "../../../../rust/crates/truapi-server/src/bootstrap/localhost-bridge.js",
        import.meta.url,
    ),
    "utf8",
);
const BRIDGE_URL = "ws://127.0.0.1:9955/?t=token";
const CYCLES = 200;

let importCounter = 0;
async function importSandbox(): Promise<typeof import("./sandbox.js")> {
    importCounter += 1;
    return import(`./sandbox.ts?recovery=${importCounter}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    binaryType = "";
    readyState: number = FakeSocket.CONNECTING;
    readonly sent: Uint8Array[] = [];

    constructor(readonly url: string) {
        super();
    }

    open(): void {
        this.readyState = FakeSocket.OPEN;
        this.dispatchEvent(new Event("open"));
    }

    send(frame: Uint8Array): void {
        if (this.readyState !== FakeSocket.OPEN) throw new Error("socket is not open");
        this.sent.push(frame);
    }

    answerHandshake(): void {
        const request = decodeWireMessage(this.sent[0]!);
        if (request.isErr()) throw request.error;
        const response = encodeWireMessage({
            requestId: request.value.requestId,
            payload: {
                ...request.value.payload,
                messageType: MESSAGE_TYPE_RESPONSE,
                value: S.Result(
                    T.VersionedHostHandshakeResponse,
                    S.CallError(T.VersionedHostHandshakeError),
                ).enc({ success: true, value: { tag: "V1", value: undefined } }),
            },
        });
        if (response.isErr()) throw response.error;
        this.dispatchEvent(new MessageEvent("message", { data: response.value.buffer }));
    }

    close(): void {
        if (this.readyState === FakeSocket.CLOSED) return;
        this.readyState = FakeSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
    }
}

function installHost() {
    const sockets: FakeSocket[] = [];
    let refuseConnections = false;

    class TrackedSocket extends FakeSocket {
        constructor(url: string) {
            super(url);
            sockets.push(this);
            if (refuseConnections) {
                queueMicrotask(() => this.dispatchEvent(new Event("error")));
            }
        }
    }

    const priorWindow = globalThis.window;
    const priorDocument = globalThis.document;
    const priorWebSocket = globalThis.WebSocket;
    const win = {
        location: {},
        dispatchEvent: () => true,
    } as unknown as Window & typeof globalThis;
    (win as unknown as { top: unknown }).top = win;
    globalThis.window = win;
    globalThis.document = { referrer: "" } as Document;
    globalThis.WebSocket = TrackedSocket as unknown as typeof WebSocket;

    const source = SOURCE.replace("__TRUAPI_BRIDGE_URL__", JSON.stringify(BRIDGE_URL)).replace(
        "__TRUAPI_BRIDGE_TOKEN__",
        JSON.stringify("token"),
    );
    const entry = new Function("window", "Event", source) as (
        window: Window,
        event: typeof Event,
    ) => void;
    entry(win, Event);

    return {
        win,
        sockets,
        refuse(value: boolean) {
            refuseConnections = value;
        },
        restore() {
            for (const socket of sockets) socket.close();
            globalThis.WebSocket = priorWebSocket;
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

describe("endpoint recovery through the real SDK", () => {
    it("connects only when consumed and reports connected only after the socket opens", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        expect(host.sockets).toEqual([]);

        const statuses: string[] = [];
        sandbox.subscribeConnectionStatus((status) => statuses.push(status));
        const client = sandbox.getClientSync();
        if (!client) throw new Error("the SDK did not detect the injected endpoint");
        const socket = host.sockets[0]!;
        const response = client.system.handshake();

        expect({ statuses, sent: socket.sent, url: socket.url }).toEqual({
            statuses: ["connecting"],
            sent: [],
            url: BRIDGE_URL,
        });

        socket.open();
        socket.answerHandshake();
        expect((await response).isOk()).toBe(true);
        expect(statuses).toEqual(["connecting", "connected"]);
    });

    it("recovers across repeated disconnects and settles pending requests and subscriptions", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        const clients = new Set<TrUApiClient>();
        const statuses: string[] = [];
        sandbox.subscribeConnectionStatus((status) => statuses.push(status));

        for (let cycle = 0; cycle < CYCLES; cycle += 1) {
            const client = sandbox.getClientSync();
            if (!client) throw new Error(`no client for recovery ${cycle}`);
            clients.add(client);
            expect(sandbox.getClientSync()).toBe(client);
            const socket = host.sockets[cycle]!;
            socket.open();

            const response = client.system.handshake();
            socket.answerHandshake();
            expect((await response).isOk()).toBe(true);

            const pending = Promise.resolve(client.system.handshake()).then(
                () => null,
                (error: unknown) => error,
            );
            const subscriptionErrors: Error[] = [];
            client.account.connectionStatusSubscribe().subscribe({
                error: (error) => subscriptionErrors.push(error),
            });
            socket.close();

            const error = await pending;
            expect(error).toBeInstanceOf(Error);
            expect({
                causes: subscriptionErrors.map((error) => error.cause),
                status: statuses.at(-1),
            }).toEqual({
                causes: [error],
                status: "disconnected",
            });
        }

        expect({
            sockets: host.sockets.length,
            clients: clients.size,
            endpoints: [...new Set(host.sockets.map((socket) => socket.url))],
            everySocketClosed: host.sockets.every((socket) => socket.readyState === FakeSocket.CLOSED),
        }).toEqual({
            sockets: CYCLES,
            clients: CYCLES,
            endpoints: [BRIDGE_URL],
            everySocketClosed: true,
        });
    });

    it("retries on demand after refused connections without requiring lifecycle hooks", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        host.refuse(true);

        for (let attempt = 0; attempt < 10; attempt += 1) {
            const client = sandbox.getClientSync();
            if (!client) throw new Error("no client for a refused connection");
            const pending = Promise.resolve(client.system.handshake()).then(
                () => null,
                (error: unknown) => error,
            );
            expect(await pending).toBeInstanceOf(Error);
            await settle();
            expect(host.sockets).toHaveLength(attempt + 1);
        }

        host.refuse(false);
        const client = sandbox.getClientSync();
        if (!client) throw new Error("the SDK did not retry the endpoint");
        const socket = host.sockets[10]!;
        socket.open();
        const response = client.system.handshake();
        socket.answerHandshake();

        expect((await response).isOk()).toBe(true);
        expect({ sockets: host.sockets.length, frames: socket.sent.length }).toEqual({
            sockets: 11,
            frames: 1,
        });
    });

    it("allows an explicit endpoint to override the injected one before connecting", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        const endpoint = "ws://127.0.0.1:1234";
        const client = sandbox.connectWebSocketHost(endpoint);

        expect({
            client: sandbox.getClientSync(),
            urls: host.sockets.map((socket) => socket.url),
        }).toEqual({ client, urls: [endpoint] });
    });

    it("compares explicit endpoint selection with the live connection, not changed host metadata", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        const client = sandbox.getClientSync();
        const changedEndpoint = "ws://127.0.0.1:1234";
        host.win.__truapi_localhost = { url: changedEndpoint, token: "changed" };

        expect(() => sandbox.connectWebSocketHost(changedEndpoint))
            .toThrow("before the TrUAPI client is created");
        expect(sandbox.connectWebSocketHost(BRIDGE_URL)).toBe(client);
        expect(host.sockets.map((socket) => socket.url)).toEqual([BRIDGE_URL]);
    });

    it("does not remove an unrelated host port when its endpoint is removed before close", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        sandbox.getClientSync();
        const channel = new MessageChannel();
        host.win.__HOST_API_PORT__ = channel.port1;
        delete host.win.__truapi_localhost;

        try {
            host.sockets[0]!.close();
            expect(host.win.__HOST_API_PORT__).toBe(channel.port1);
        } finally {
            channel.port1.close();
            channel.port2.close();
        }
    });

    it("ignores late close and error events from a replaced connection", async () => {
        host = installHost();
        const sandbox = await importSandbox();
        sandbox.getClientSync();
        const retired = host.sockets[0]!;
        retired.open();
        retired.close();

        const client = sandbox.getClientSync();
        if (!client) throw new Error("the SDK did not replace the closed client");
        const current = host.sockets[1]!;
        current.open();
        retired.dispatchEvent(new Event("error"));
        retired.dispatchEvent(new Event("close"));
        expect(sandbox.getClientSync()).toBe(client);

        const response = client.system.handshake();
        current.answerHandshake();
        expect((await response).isOk()).toBe(true);
        expect(host.sockets).toHaveLength(2);
    });
});
