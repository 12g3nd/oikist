import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { startHookServer, type HookServer } from "../src/main/agents/hook-server.js";
import type { HookEvent } from "../src/shared/hooks.js";

const SESSION = "310ff72c-7a29-4972-acc8-edb59ebee744";

async function withServer(run: (server: HookServer, seen: HookEvent[]) => Promise<void>): Promise<void> {
  const seen: HookEvent[] = [];
  const server = await startHookServer((event) => void seen.push(event));
  try {
    await run(server, seen);
  } finally {
    await server.close();
  }
}

interface Reply {
  readonly status: number;
}

/**
 * Sends one request with keep-alive off.
 *
 * `fetch` is deliberately avoided: its connection pool holds sockets open past the test,
 * and `--test-force-exit` then terminates the process while those handles are still
 * closing, which trips a libuv assertion on Windows.
 */
function send(
  server: HookServer,
  options: { method?: string; path?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Reply> {
  const url = new URL(server.endpoint);
  const payload =
    options.body === undefined
      ? ""
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(url.port),
        method: options.method ?? "POST",
        path: options.path ?? "/hook",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...options.headers
        }
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.once("error", reject);
    req.end(payload);
  });
}

function post(server: HookServer, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return send(server, { body, headers: { "x-oikist-token": server.token, ...headers } });
}

test("it binds loopback on an OS-assigned port, never a fixed one", async () => {
  await withServer(async (server) => {
    const url = new URL(server.endpoint);
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(Number(url.port) > 0);
    assert.equal(server.token.length, 64, "a per-run token, not a constant");
  });
});

test("a valid event is accepted and delivered", async () => {
  await withServer(async (server, seen) => {
    const response = await post(server, { sessionId: SESSION, kind: "needs-permission" });
    assert.equal(response.status, 204);
    assert.deepEqual(seen, [{ sessionId: SESSION, kind: "needs-permission" }]);
  });
});

test("a request without the token is refused and delivers nothing", async () => {
  await withServer(async (server, seen) => {
    const response = await send(server, { body: { sessionId: SESSION, kind: "turn-start" } });
    assert.equal(response.status, 403);
    assert.deepEqual(seen, [], "an unauthenticated post must not be able to forge agent state");
  });
});

test("a wrong token is refused", async () => {
  await withServer(async (server, seen) => {
    const response = await post(server, { sessionId: SESSION, kind: "turn-start" }, { "x-oikist-token": "0".repeat(64) });
    assert.equal(response.status, 403);
    assert.deepEqual(seen, []);
  });
});

test("a foreign Host header is refused, so a browser page cannot post here", async () => {
  await withServer(async (server, seen) => {
    // fetch forbids overriding Host, so this goes over a raw socket.
    const { connect } = await import("node:net");
    const url = new URL(server.endpoint);
    const body = JSON.stringify({ sessionId: SESSION, kind: "turn-start" });
    const socket = connect(Number(url.port), "127.0.0.1");
    socket.setEncoding("utf8");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `POST /hook HTTP/1.1\r\nHost: evil.example.com\r\n` +
        `x-oikist-token: ${server.token}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    );
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    await new Promise((resolve) => socket.once("end", resolve));

    assert.match(received.split("\r\n")[0] ?? "", /403/);
    assert.deepEqual(seen, []);
  });
});

test("only POST /hook is served", async () => {
  await withServer(async (server) => {
    const token = { "x-oikist-token": server.token };
    assert.equal((await send(server, { method: "GET", headers: token })).status, 404);
    assert.equal((await send(server, { path: "/other", headers: token })).status, 404);
  });
});

test("a malformed or over-sized body is refused without delivering", async () => {
  await withServer(async (server, seen) => {
    assert.equal((await post(server, "not json")).status, 400);
    assert.equal((await post(server, { sessionId: SESSION })).status, 400);
    assert.equal((await post(server, { sessionId: SESSION, kind: "__proto__" })).status, 400);

    const huge = JSON.stringify({ sessionId: SESSION, kind: "turn-start", pad: "x".repeat(10_000) });
    const response = await post(server, huge).catch(() => null);
    assert.notEqual(response?.status, 204);
    assert.deepEqual(seen, []);
  });
});
