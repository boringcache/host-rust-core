import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedRemotePermissionRequest,
  VersionedRemotePermissionResponse,
  VersionedRemotePermissionError,
} from "@parity/truapi";
import { PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION } from "../js/packages/truapi/src/generated/wire-table.ts";

const repository = resolve(import.meta.dir, "..");
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "truapi-cli-package-"));
  const result = Bun.spawnSync(
    ["make", "cli-runner", `CLI_DIST_DIR=${directory}`],
    {
      cwd: repository,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("resolves the packaged runner without a source checkout", async () => {
  const preload = join(directory, "stack-format.js");
  await writeFile(
    preload,
    'Error.prepareStackTrace = () => "Error\\n    at package-test";',
  );
  for (const args of [[], ["--preload", preload]]) {
    const result = Bun.spawnSync(
      [process.execPath, ...args, join(directory, "runner.js")],
      {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH },
      },
    );
    expect({
      status: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    }).toEqual({
      status: 1,
      output: expect.stringContaining("TRUAPI_FRAME_URL must be set"),
    });
  }
});

it("runs installed TypeScript with host access and shared web permissions", async () => {
  const authorizations: unknown[] = [];
  const decisions: boolean[] = [];
  const requests: string[] = [];
  let granted = false;
  let connections = 0;
  const server = Bun.serve<{ frames: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { frames: new URL(request.url).pathname === "/frames" },
        })
      )
        return;
      requests.push(new URL(request.url).pathname);
      return new Response("http-ok");
    },
    websocket: {
      open(socket) {
        if (socket.data.frames) connections++;
      },
      message(socket, message) {
        if (!socket.data.frames) {
          socket.send(message);
          return;
        }
        const request = decodeWireMessage(
          new Uint8Array(message as Buffer),
        )._unsafeUnwrap();
        let allowed = true;
        if (
          request.payload.methodId ===
          PERMISSIONS_AUTHORIZE_REMOTE_PERMISSION.method
        ) {
          allowed = granted;
          granted = false;
          decisions.push(allowed);
          authorizations.push(
            VersionedRemotePermissionRequest.dec(request.payload.value),
          );
        } else granted = true;
        socket.send(
          encodeWireMessage({
            ...request,
            payload: {
              ...request.payload,
              messageType: MESSAGE_TYPE_RESPONSE,
              value: scale
                .Result(
                  VersionedRemotePermissionResponse,
                  scale.CallError(VersionedRemotePermissionError),
                )
                .enc({
                  success: true,
                  value: { tag: "V1", value: { granted: allowed } },
                }),
            },
          })._unsafeUnwrap(),
        );
      },
    },
  });
  const script = join(directory, "websocket-product.ts");
  await writeFile(
    script,
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    assert(Object.getOwnPropertyDescriptor(globalThis, 'fetch').configurable === false);
    const expected: string = process.env.PACKAGED_TEST_VALUE!;
    const report = join(import.meta.dir, 'report.txt');
    writeFileSync(report, expected);
    assert(readFileSync(report, 'utf8') === expected);
    async function allowOnce() {
      assert((await truapi.permissions.requestRemotePermission({
        permission: { tag: 'Remote', value: { domains: ['127.0.0.1'] } },
      }))._unsafeUnwrap().granted);
    }
    await allowOnce();
    assert(await (await fetch('http://127.0.0.1:${server.port}/allowed')).text() === 'http-ok');
    try { await fetch('http://127.0.0.1:${server.port}/denied'); throw new Error('grant reused'); }
    catch (error) { assert(error instanceof TypeError); }
    await allowOnce();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket('ws://127.0.0.1:${server.port}/echo');
      socket.onopen = () => socket.send(expected);
      socket.onmessage = ({ data }) => {
        if (data !== expected) return reject(new Error('Unexpected reply'));
        socket.close();
        console.log(data);
        resolve();
      };
      socket.onerror = () => reject(new Error('WebSocket failed'));
    });
  `,
  );
  const child = Bun.spawn([process.execPath, join(directory, "runner.js")], {
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH,
      PACKAGED_TEST_VALUE: "packaged-websocket-ok",
      TRUAPI_FRAME_URL: `ws://127.0.0.1:${server.port}/frames`,
      TRUAPI_PRODUCT_ID: "package-test.dot",
      TRUAPI_SCRIPT: script,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const [status, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(
      {
        status,
        output,
        report: await readFile(join(directory, "report.txt"), "utf8").catch(
          () => null,
        ),
        requests,
        authorizations,
        decisions,
        connections,
        container:
          (await readFile(join(directory, "sandbox-assets/container.js")))
            .length > 0,
      },
      error,
    ).toEqual({
      status: 0,
      output: "packaged-websocket-ok\n",
      report: "packaged-websocket-ok",
      requests: ["/allowed"],
      decisions: [true, false, true],
      connections: 1,
      container: true,
      authorizations: Array(3).fill({
        tag: "V1",
        value: {
          permission: { tag: "Remote", value: { domains: ["127.0.0.1"] } },
        },
      }),
    });
  } finally {
    clearTimeout(timeout);
    child.kill();
    server.stop(true);
  }
}, 20_000);
