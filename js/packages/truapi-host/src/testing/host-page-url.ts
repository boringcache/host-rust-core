// The host page reads its configuration from the page URL, so both entry
// points -- the Playwright fixture and a directly-started server -- configure
// a host the same way: by building the same query string.
//
// Keeping it here rather than inline in each means a new option cannot be
// taught to one entry point and forgotten by the other.
import type { MockHostConfig } from "../web/create-mock-host.js";

/** Host configuration the page understands. */
export interface HostPageConfig {
  /** URL of the product under test. */
  productUrl: string;
  /** dotNS identifier the host runs the product under. */
  productId?: string;
  /** Behaviour knobs forwarded to the mock host. */
  mock?: MockHostConfig;
  /** Overrides merged into the host's runtime config. */
  runtimeConfig?: Record<string, unknown>;
  /** Names of the accounts the host can sign as. */
  accounts?: string[];
  /** Whether the host starts signed in. */
  loginBehavior?: "auto" | "manual";
  /**
   * Where the core runs. `"worker"` is the production topology and the
   * default. `"main-thread"` is the debugging one: the core's log output
   * reaches the page console, where `page.on("console")` can read it, instead
   * of the worker console Playwright does not observe.
   */
  topology?: "worker" | "main-thread";
  /**
   * Core log level (`off`/`error`/`warn`/`info`/`debug`/`trace`). Raising it
   * is what turns a bare failure outcome into the reason behind it: the core
   * logs why a call failed before mapping it to a protocol answer.
   */
  logLevel?: string;
}

/** Apply `config` to a host page URL, returning the configured URL. */
export function hostPageUrl(base: string, config: HostPageConfig): string {
  const url = new URL(base);
  url.searchParams.set("product", config.productUrl);
  if (config.mock) url.searchParams.set("mock", JSON.stringify(config.mock));
  if (config.productId) url.searchParams.set("productId", config.productId);
  if (config.runtimeConfig) {
    url.searchParams.set("runtimeConfig", JSON.stringify(config.runtimeConfig));
  }
  if (config.accounts) {
    url.searchParams.set("accounts", config.accounts.join(","));
  }
  if (config.loginBehavior) url.searchParams.set("login", config.loginBehavior);
  if (config.topology) url.searchParams.set("topology", config.topology);
  if (config.logLevel) url.searchParams.set("logLevel", config.logLevel);
  return url.toString();
}
