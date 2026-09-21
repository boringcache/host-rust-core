import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(
    new URL(
        "../../../../rust/crates/truapi-server/src/bootstrap/localhost-bridge.js",
        import.meta.url,
    ),
    "utf8",
).replace("__TRUAPI_BRIDGE_URL__", JSON.stringify("ws://127.0.0.1:9955/?t=token"))
    .replace("__TRUAPI_BRIDGE_TOKEN__", JSON.stringify("token"));

interface BootstrapWindow {
    __HOST_API_PORT__?: object;
    __HOST_WEBVIEW_MARK__?: boolean;
    __truapi_localhost?: { url: string; token: string };
    __pauseConnections__?: () => void;
    __resumeConnections__?: () => void;
    dispatchEvent(event: Event): boolean;
}

function installBootstrap(existing: Partial<BootstrapWindow> = {}) {
    const events: string[] = [];
    const win: BootstrapWindow = {
        ...existing,
        dispatchEvent(event) {
            events.push(event.type);
            return true;
        },
    };
    const entry = new Function("window", "Event", SOURCE) as (
        window: BootstrapWindow,
        event: typeof Event,
    ) => void;
    entry(win, Event);
    return { win, events };
}

describe("localhost bootstrap", () => {
    it("publishes the endpoint and compatibility port without lifecycle hooks", () => {
        const host = installBootstrap();

        expect({
            endpoint: host.win.__truapi_localhost,
            mark: host.win.__HOST_WEBVIEW_MARK__,
            port: typeof host.win.__HOST_API_PORT__,
            pause: host.win.__pauseConnections__,
            resume: host.win.__resumeConnections__,
            events: host.events,
        }).toEqual({
            endpoint: { url: "ws://127.0.0.1:9955/?t=token", token: "token" },
            mark: true,
            port: "object",
            pause: undefined,
            resume: undefined,
            events: ["truapi-native-ready"],
        });
    });

    it("preserves a port supplied by another host", () => {
        const port = {};
        const host = installBootstrap({ __HOST_API_PORT__: port });

        expect({
            port: host.win.__HOST_API_PORT__,
            endpoint: host.win.__truapi_localhost,
            events: host.events,
        }).toEqual({ port, endpoint: undefined, events: [] });
    });

    it("preserves an endpoint already installed by the host", () => {
        const endpoint = { url: "ws://127.0.0.1:1234", token: "existing" };
        const host = installBootstrap({ __truapi_localhost: endpoint });

        expect({ endpoint: host.win.__truapi_localhost, events: host.events }).toEqual({
            endpoint,
            events: [],
        });
    });

    it("leaves product lifecycle hooks intact", () => {
        const pause = () => {};
        const resume = () => {};
        const host = installBootstrap({
            __pauseConnections__: pause,
            __resumeConnections__: resume,
        });

        expect({
            pause: host.win.__pauseConnections__,
            resume: host.win.__resumeConnections__,
        }).toEqual({ pause, resume });
    });
});
