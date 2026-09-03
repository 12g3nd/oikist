import test from "node:test";
import assert from "node:assert/strict";

import { AgentDiscovery, type DiscoveryResult } from "../src/main/agents/discovery.js";

const ENTRY = {
  pid: 4242,
  cwd: "C:\\Users\\SJ\\oikist",
  kind: "interactive",
  startedAt: 1788407745027,
  sessionId: "310ff72c-7a29-4972-acc8-edb59ebee744",
  name: "oikist-e9"
};

test("a successful pass reports the agents and marks the provider healthy", async () => {
  const results: DiscoveryResult[] = [];
  const discovery = new AgentDiscovery({ read: async () => [ENTRY], onResult: (r) => void results.push(r) });

  await discovery.refresh();

  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, true);
  assert.equal(results[0]?.agents.length, 1);
  assert.equal(results[0]?.agents[0]?.title, "oikist-e9");
});

test("a failed read keeps the last known agents rather than reporting none", async () => {
  const results: DiscoveryResult[] = [];
  let fail = false;
  const discovery = new AgentDiscovery({
    read: async () => {
      if (fail) {
        throw new Error("claude is not on PATH");
      }
      return [ENTRY];
    },
    onResult: (r) => void results.push(r)
  });

  await discovery.refresh();
  fail = true;
  await discovery.refresh();

  const latest = results.at(-1)!;
  assert.equal(latest.ok, false, "the provider is reported unhealthy");
  assert.equal(latest.agents.length, 1, "and the last known agents survive");
  assert.match(latest.error ?? "", /not on PATH/);
});

test("an error message is truncated, so a huge stack cannot reach the UI", async () => {
  const results: DiscoveryResult[] = [];
  const discovery = new AgentDiscovery({
    read: async () => {
      throw new Error("x".repeat(5000));
    },
    onResult: (r) => void results.push(r)
  });

  await discovery.refresh();
  assert.ok((results[0]?.error ?? "").length <= 200);
});

test("passes never overlap, so a slow provider cannot pile up", async () => {
  let started = 0;
  let resolveRead: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });

  const discovery = new AgentDiscovery({
    read: async () => {
      started += 1;
      await gate;
      return [];
    },
    onResult: () => {}
  });

  const first = discovery.refresh();
  await discovery.refresh();
  assert.equal(started, 1, "the second pass returned immediately rather than starting a read");

  resolveRead!();
  await first;

  await discovery.refresh();
  assert.equal(started, 2, "once the first finished, a later pass runs normally");
});

test("garbage from the CLI yields no agents rather than throwing", async () => {
  const results: DiscoveryResult[] = [];
  const discovery = new AgentDiscovery({ read: async () => "not json at all", onResult: (r) => void results.push(r) });
  await discovery.refresh();
  assert.equal(results[0]?.ok, true, "the CLI answered; it simply said nothing usable");
  assert.deepEqual(results[0]?.agents, []);
});
