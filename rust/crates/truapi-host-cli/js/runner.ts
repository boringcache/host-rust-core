// Product scripts run in the shared browser container by default.
import type {
  ProductAccountId,
  TrUApiClient,
} from "../../../../js/packages/truapi/src/index.ts";
import { runSandboxScript } from "./sandbox-runner.ts";
import { runTrustedScript } from "./trusted-runner.ts";

/// The host context injected alongside `truapi`. It only exposes what a script
/// can't get from `truapi` alone: the product id the host serves, so product
/// accounts stay in sync with `--product-id` (hardcoding a mismatched id fails
/// signing with `PermissionDenied`). Use `console.log` / `throw` for the rest.
export interface HostContext {
  /** The product id this host serves (its `--product-id`). */
  productId: string;
  /** A product account id for `derivationIndex` (default 0) under this product. */
  productAccount(index?: number): ProductAccountId;
}

declare global {
  // eslint-disable-next-line no-var
  var truapi: TrUApiClient;
  // eslint-disable-next-line no-var
  var host: HostContext;
  // Playground examples receive this helper from `runExample`; expose the
  // same contract to directly imported CLI scripts.
  // eslint-disable-next-line no-var
  var assert: (condition: unknown, ...message: unknown[]) => asserts condition;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main() {
  const frameUrl = requireEnv("TRUAPI_FRAME_URL");
  const productId = requireEnv("TRUAPI_PRODUCT_ID");
  const scriptPath = requireEnv("TRUAPI_SCRIPT");
  const mode = process.env.TRUAPI_SCRIPT_MODE ?? "sandboxed";
  if (mode === "trusted") {
    if (process.env.TRUAPI_SCRIPT_CWD)
      process.chdir(process.env.TRUAPI_SCRIPT_CWD);
    console.error(
      "[runner] Trusted script mode: running with host Bun capabilities",
    );
    await runTrustedScript(frameUrl, productId, scriptPath);
  } else if (mode === "sandboxed") {
    await runSandboxScript(frameUrl, productId, scriptPath);
  } else {
    throw new Error("TRUAPI_SCRIPT_MODE must be sandboxed or trusted");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    const message = String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const detail = stack?.includes(message)
      ? stack
      : `${message}${stack ? `\n${stack}` : ""}`;
    console.error(`[script error] ${detail}`);
    process.exit(1);
  },
);
