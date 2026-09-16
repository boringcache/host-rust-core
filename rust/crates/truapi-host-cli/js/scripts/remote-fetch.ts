/// <reference path="../runner.ts" />

export async function runRemoteFetch(endpoint: string) {
  async function attemptFetch(phase: string) {
    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(15_000),
      });
      const outcome = {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      };
      console.log(`REMOTE_FETCH ${phase} ${JSON.stringify(outcome)}`);
      return outcome;
    } catch (error) {
      const outcome = {
        ok: false,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      };
      console.log(`REMOTE_FETCH ${phase} ${JSON.stringify(outcome)}`);
      return outcome;
    }
  }

  const domain = new URL(endpoint).hostname;
  console.log(`REMOTE_FETCH_ENDPOINT ${JSON.stringify({ endpoint, domain })}`);
  const before = await attemptFetch("before grant");
  const permission = await truapi.permissions.requestRemotePermission({
    permission: { tag: "Remote", value: { domains: [domain] } },
  });
  if (!permission.isOk()) {
    throw new Error(
      `Remote permission failed: ${JSON.stringify(permission.error)}`,
    );
  }
  console.log(`REMOTE_PERMISSION ${JSON.stringify(permission.value)}`);
  if (!permission.value.granted) {
    throw new Error(`Remote permission denied for ${domain}`);
  }

  const after = await attemptFetch("after grant");
  const report = { endpoint, domain, before, granted: true, after };
  console.log(`REMOTE_FETCH_REPORT ${JSON.stringify(report)}`);
  if (!after.ok) {
    throw new Error(`Fetch after grant failed: ${JSON.stringify(after)}`);
  }
  return report;
}

export default async function () {
  return runRemoteFetch(
    process.env.REMOTE_FETCH_URL ??
      "https://jsonplaceholder.typicode.com/todos/1",
  );
}
