// resources/hook-relay.mjs
//
// Runs as a Claude Code hook and forwards one event to oikist's loopback listener.
//
// Not bundled: Claude launches this with a real Node binary, outside the app, so it must
// be a standalone module with no imports beyond node builtins.
//
// THE CONTRACT: this process must always exit 0, and must always exit quickly. A hook
// that fails, hangs, or writes to stderr degrades the agent it is attached to — the
// whole point is to observe an agent, never to interfere with one. Every failure path
// below is therefore silent and still exits 0.

import { setTimeout as delay } from "node:timers/promises";

/** Beyond this the payload is not a hook event, and reading it is a denial of service. */
const MAX_STDIN_BYTES = 65_536;

/** Well inside Claude's own hook timeout, so oikist is never the thing that blocks. */
const DEADLINE_MS = 3_000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return typeof value === "string" && value !== "" ? value : null;
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) {
      return "";
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const kind = argValue("--kind");
  const endpoint = argValue("--endpoint");
  const token = argValue("--token");
  if (kind === null || endpoint === null || token === null) {
    return;
  }

  let sessionId = null;
  let label = null;
  try {
    const payload = JSON.parse(await readStdin());
    // Claude sends snake_case on the hook payload.
    if (payload !== null && typeof payload === "object" && typeof payload.session_id === "string") {
      sessionId = payload.session_id;
      // Present on subagent events. Which kind of subagent is far more useful than a
      // bare count, and it is the only payload field forwarded: everything else in a
      // hook payload is prompt or tool text.
      for (const field of ["subagent_type", "agent_type", "subagent_name"]) {
        if (typeof payload[field] === "string" && payload[field] !== "") {
          label = payload[field];
          break;
        }
      }
    }
  } catch {
    return;
  }
  if (sessionId === null) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-oikist-token": token },
      // Only the session and the kind. The hook payload itself is never forwarded: it
      // can contain prompt text and tool output, and none of that belongs in a status
      // panel or in oikist's memory.
      body: JSON.stringify(label === null ? { sessionId, kind } : { sessionId, kind, label }),
      signal: controller.signal
    });
  } catch {
    // oikist not listening, or the deadline passed. Neither is the agent's problem.
  } finally {
    clearTimeout(timer);
  }
}

// A hard stop even if something above wedges: the agent must not wait on us.
await Promise.race([main().catch(() => {}), delay(DEADLINE_MS + 500)]);
process.exit(0);
