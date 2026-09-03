import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_ORDER,
  compareAgents,
  parseClaudeAgents,
  projectFromCwd,
  type AgentSummary
} from "../src/shared/agents.js";

const VALID = {
  pid: 31412,
  cwd: "C:\\Users\\SJ\\oikist",
  kind: "interactive",
  startedAt: 1788407745027,
  sessionId: "310ff72c-7a29-4972-acc8-edb59ebee744",
  name: "oikist-e9"
};

test("a well-formed entry becomes an attached agent, known with confidence not certainty", () => {
  const [agent] = parseClaudeAgents([VALID]);
  assert.equal(agent?.provider, "claude");
  assert.equal(agent?.sessionId, VALID.sessionId);
  assert.equal(agent?.pid, VALID.pid);
  assert.equal(agent?.cwd, VALID.cwd);
  assert.equal(agent?.project, "oikist");
  assert.equal(agent?.title, "oikist-e9");
  assert.equal(agent?.origin, "attached");
  assert.equal(agent?.confidence, "confident", "nothing oikist did not launch is ever certain");
  assert.equal(agent?.activity, "unknown", "identity is not activity; only a hook can say more");
});

test("output that is not an array yields nothing rather than throwing", () => {
  for (const value of [null, undefined, {}, "", 7, { agents: [] }]) {
    assert.deepEqual(parseClaudeAgents(value), []);
  }
});

test("a malformed entry is dropped, and its neighbours survive", () => {
  const parsed = parseClaudeAgents([
    { ...VALID, sessionId: "not-a-uuid" },
    { ...VALID, pid: 0 },
    { ...VALID, pid: -3 },
    { ...VALID, pid: 1.5 },
    { ...VALID, cwd: 42 },
    null,
    "nope",
    { ...VALID, sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", pid: 999 }
  ]);
  assert.equal(parsed.length, 1, "only the well-formed entry survives");
  assert.equal(parsed[0]?.pid, 999);
});

test("duplicate session ids collapse, since one session is one agent", () => {
  const parsed = parseClaudeAgents([VALID, { ...VALID, pid: 555 }]);
  assert.equal(parsed.length, 1);
});

test("a missing name falls back to the project rather than rendering blank", () => {
  const [agent] = parseClaudeAgents([{ ...VALID, name: "" }]);
  assert.equal(agent?.title, "oikist");
});

test("projectFromCwd takes the last real path segment on either separator", () => {
  assert.equal(projectFromCwd("C:\\Users\\SJ\\oikist"), "oikist");
  assert.equal(projectFromCwd("C:\\Users\\SJ\\oikist\\"), "oikist");
  assert.equal(projectFromCwd("/home/sj/fallow"), "fallow");
  assert.equal(projectFromCwd("C:\\"), "");
  assert.equal(projectFromCwd(""), "");
});

test("agents sort attention-first, so the one that needs you is never below the ones that do not", () => {
  const make = (activity: AgentSummary["activity"], sessionId: string): AgentSummary => ({
    provider: "claude",
    sessionId,
    activity,
    origin: "attached",
    confidence: "confident",
    title: sessionId,
    startedAt: 0
  });

  const sorted = [
    make("idle", "d"),
    make("working", "c"),
    make("unknown", "e"),
    make("needsPermission", "a"),
    make("waitingForInput", "b")
  ].sort(compareAgents);

  assert.deepEqual(
    sorted.map((agent) => agent.activity),
    ["needsPermission", "waitingForInput", "working", "idle", "unknown"]
  );
  assert.deepEqual([...ATTENTION_ORDER], sorted.map((agent) => agent.activity));
});

test("agents in the same state sort by most recently started", () => {
  const base = { provider: "claude", activity: "working", origin: "attached", confidence: "confident" } as const;
  const sorted = [
    { ...base, sessionId: "old", title: "old", startedAt: 1000 },
    { ...base, sessionId: "new", title: "new", startedAt: 5000 }
  ].sort(compareAgents);
  assert.equal(sorted[0]?.sessionId, "new");
});
