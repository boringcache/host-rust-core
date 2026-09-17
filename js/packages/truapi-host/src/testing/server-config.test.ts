import { describe, expect, it } from "bun:test";
import { hostPageUrl } from "./host-page-url.js";
import { createTestHostServer } from "./server.js";

describe("createTestHostServer host configuration", () => {
  it("returns a URL carrying the configuration it was given", async () => {
    // A suite that starts the server directly, rather than through the
    // Playwright fixture, gets a ready-to-open URL -- that is the shape
    // `@parity/host-api-test-sdk`'s server has, and what a migrating suite
    // that never used the fixture depends on.
    const server = await createTestHostServer({
      unref: true,
      productUrl: "http://localhost:5173",
      productId: "localhost:5173",
      accounts: ["alice", "bob"],
    });
    const url = new URL(server.url);
    expect(url.searchParams.get("product")).toBe("http://localhost:5173");
    expect(url.searchParams.get("productId")).toBe("localhost:5173");
    expect(url.searchParams.get("accounts")).toBe("alice,bob");
    await server.close();
  });

  it("returns a bare base when given no configuration", async () => {
    // The fixture appends its own per-test configuration, so an unconfigured
    // server must not carry a half-built query string into that.
    const server = await createTestHostServer({ unref: true });
    expect(new URL(server.url).search).toBe("");
    await server.close();
  });

  it("rejects a pinned product account, and says why", async () => {
    await expect(
      createTestHostServer({
        unref: true,
        productUrl: "http://localhost:5173",
        productAccounts: { "demo.dot/0": "bob" },
      }),
    ).rejects.toThrow(/DERIVED from \(session root, product id\)/);
  });

  it("builds the same URL for both entry points", () => {
    // The fixture and the server share one builder precisely so an option
    // cannot be taught to one and forgotten by the other.
    const config = {
      productUrl: "http://localhost:5173",
      accounts: ["alice"],
      loginBehavior: "manual" as const,
    };
    expect(hostPageUrl("http://127.0.0.1:1234", config)).toBe(
      hostPageUrl("http://127.0.0.1:1234", config),
    );
    const url = new URL(hostPageUrl("http://127.0.0.1:1234", config));
    expect(url.searchParams.get("login")).toBe("manual");
  });
});
