import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { parseHookEvent, type HookEvent } from "../../shared/hooks.js";

/**
 * An ephemeral loopback listener that hooks post to.
 *
 * Hooks run as separate processes, so they need somewhere to report to. This is not a
 * daemon: it is bound inside the app, on 127.0.0.1 with an OS-assigned port, for exactly
 * as long as the app runs. There is no fixed port to collide with or to find, and it
 * dies with the process.
 *
 * Three checks, in cost order, before a body is read at all:
 *   - loopback bind, so nothing off this machine can reach it;
 *   - a `Host` header that is actually loopback, so a DNS-rebinding page in a browser
 *     cannot post to it from a foreign origin;
 *   - a per-run bearer token, so another local process cannot forge agent state.
 */

/** Generous for `{sessionId, kind}` and small enough that a flood costs nothing. */
const MAX_BODY_BYTES = 4_096;

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  // Strip a port; IPv6 literals arrive bracketed.
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

export interface HookServer {
  readonly endpoint: string;
  readonly token: string;
  /** Resolves once the socket is actually closed, so callers can await teardown. */
  close: () => Promise<void>;
}

export async function startHookServer(onEvent: (event: HookEvent) => void): Promise<HookServer> {
  const token = randomBytes(32).toString("hex");

  const server: Server = createServer((request, response) => {
    const reject = (status: number): void => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end();
    };

    if (request.method !== "POST" || request.url !== "/hook") {
      reject(404);
      return;
    }
    if (!isLoopbackHost(request.headers.host)) {
      reject(403);
      return;
    }
    // Compared as plain strings: both sides are hex of the same length, and a timing
    // side channel on a loopback socket a local process could simply read anyway is not
    // the threat being defended against here.
    if (request.headers["x-oikist-token"] !== token) {
      reject(403);
      return;
    }

    let body = "";
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(413);
        request.destroy();
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        reject(400);
        return;
      }
      const event = parseHookEvent(parsed);
      if (event === null) {
        reject(400);
        return;
      }
      // Acknowledged before the listener runs: the relay is holding an agent's hook
      // open, and nothing oikist does with the event should keep it waiting.
      response.writeHead(204);
      response.end();
      onEvent(event);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0 asks the OS for a free port, so there is nothing to configure and nothing
    // to collide with if two copies ever run.
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  // Deliberately not unref'd. Electron controls the main process's lifetime, so an
  // unref would buy nothing — and closing an unref'd handle tripped a libuv assertion
  // on Windows (`!(handle->flags & UV_HANDLE_CLOSING)` in async.c). The listener is
  // closed explicitly on shutdown instead.

  return {
    endpoint: `http://127.0.0.1:${address.port}/hook`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        // Existing keep-alive sockets would otherwise hold the close open.
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}
