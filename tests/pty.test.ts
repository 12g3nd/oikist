import test from "node:test";
import assert from "node:assert/strict";

import { PtyManager } from "../src/main/pty.js";
import { IPC } from "../src/shared/ipc.js";

interface Sent {
  readonly channel: string;
  readonly payload: { id: string; chunk?: string; exitCode?: number };
}

function collector(): { sent: Sent[]; send: (channel: string, payload: unknown) => void } {
  const sent: Sent[] = [];
  return { sent, send: (channel, payload) => void sent.push({ channel, payload: payload as Sent["payload"] }) };
}

/** Waits for `predicate` to hold, or fails the test rather than hanging the suite. */
async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a shell starts and its output reaches the renderer", async () => {
  const { sent, send } = collector();
  const manager = new PtyManager(send);
  const id = await manager.create({ cols: 80, rows: 24 });

  assert.equal(typeof id, "string");
  manager.write(id, "echo oikist-pty-marker\r");

  await until(
    () => sent.some((m) => m.channel === IPC.ptyData && (m.payload.chunk ?? "").includes("oikist-pty-marker")),
    "the echoed marker to arrive"
  );
  manager.dispose(id);
});

test("output is batched, so a burst is not one IPC message per read", async () => {
  const { sent, send } = collector();
  const manager = new PtyManager(send);
  const id = await manager.create({ cols: 200, rows: 50 });

  // Enough output that an unbatched implementation would send far more messages than
  // there are flush windows. The exact count is timing-dependent; the invariant is that
  // batching collapses many reads into few messages.
  manager.write(id, "for /L %i in (1,1,400) do @echo line-%i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r");

  await until(
    () => sent.filter((m) => m.channel === IPC.ptyData).some((m) => (m.payload.chunk ?? "").includes("line-400-")),
    "the last line to arrive"
  );

  const messages = sent.filter((m) => m.channel === IPC.ptyData);
  const totalBytes = messages.reduce((sum, m) => sum + (m.payload.chunk ?? "").length, 0);
  assert.ok(totalBytes > 20_000, `expected a real burst, saw ${totalBytes} bytes`);
  assert.ok(
    messages.length < 100,
    `expected batching to collapse ${totalBytes} bytes into few messages, got ${messages.length}`
  );
  manager.dispose(id);
});

test("exit is reported, and pending output is flushed before it", async () => {
  const { sent, send } = collector();
  const manager = new PtyManager(send);
  const id = await manager.create({ cols: 80, rows: 24 });

  manager.write(id, "echo before-exit-marker\r");
  manager.write(id, "exit\r");

  await until(() => sent.some((m) => m.channel === IPC.ptyExit), "the exit notice");

  const exitIndex = sent.findIndex((m) => m.channel === IPC.ptyExit);
  const before = sent
    .slice(0, exitIndex)
    .filter((m) => m.channel === IPC.ptyData)
    .map((m) => m.payload.chunk ?? "")
    .join("");

  assert.ok(before.includes("before-exit-marker"), "output produced before exit must arrive before the exit notice");
  assert.equal(typeof sent[exitIndex]?.payload.exitCode, "number");
});

test("writing to, resizing, or disposing an unknown id is inert", () => {
  const { sent, send } = collector();
  const manager = new PtyManager(send);

  manager.write("no-such-id", "hello");
  manager.resize("no-such-id", 10, 10);
  manager.dispose("no-such-id");

  assert.deepEqual(sent, []);
});

test("disposeAll leaves no session behind", async () => {
  const { sent, send } = collector();
  const manager = new PtyManager(send);
  const first = await manager.create({ cols: 80, rows: 24 });
  const second = await manager.create({ cols: 80, rows: 24 });
  assert.notEqual(first, second, "each shell gets its own id");

  manager.disposeAll();
  // A disposed session accepts writes without throwing and produces nothing further.
  manager.write(first, "echo should-not-appear\r");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    sent.some((m) => (m.payload.chunk ?? "").includes("should-not-appear")),
    false
  );
});
