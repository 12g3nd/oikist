import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_ORDER,
  compareAgents,
  parseClaudeAgents,
  AGENT_FAILED_BEFORE_MS,
  describeAgentExit,
  mergeAgents,
  projectFromCwd,
  type AgentSummary
} from "../src/shared/agents.js";

const VALID = {
  pid: 31412,
  cwd: "C:\\\\Users\\\\SJ\\\\oikist",
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

// --- merging what we launched with what we found ---

const ATTACHED: AgentSummary = {
  provider: "claude",
  sessionId: VALID.sessionId,
  activity: "unknown",
  origin: "attached",
  confidence: "confident",
  title: "oikist-e9",
  startedAt: 1000,
  pid: 31412,
  cwd: "C:\\Users\\SJ\\oikist",
  project: "oikist"
};

test("a launched agent wins over the same session found by the poller", () => {
  const merged = mergeAgents(
    [{ sessionId: VALID.sessionId, activity: "needsPermission", startedAt: 2000 }],
    [ATTACHED]
  );
  assert.equal(merged.length, 1, "one session is one row");
  assert.equal(merged[0]?.activity, "needsPermission", "hook-reported state beats the poller's guess");
  assert.equal(merged[0]?.origin, "launched");
  assert.equal(merged[0]?.confidence, "certain");
});

test("merging keeps the pid and name discovery knows and a launch record lacks", () => {
  const [merged] = mergeAgents([{ sessionId: VALID.sessionId, activity: "working", startedAt: 0 }], [ATTACHED]);
  assert.equal(merged?.pid, 31412);
  assert.equal(merged?.title, "oikist-e9");
  assert.equal(merged?.cwd, "C:\\Users\\SJ\\oikist");
  assert.equal(merged?.startedAt, 1000, "a launch with no time falls back to the discovered one");
});

test("a launched agent the poller has not seen yet still appears", () => {
  const merged = mergeAgents(
    [{ sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", activity: "working", startedAt: 5, cwd: "D:\\work\\fallow" }],
    []
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.project, "fallow");
  assert.equal(merged[0]?.title, "fallow");
});

test("attached agents with no launch record are untouched", () => {
  assert.deepEqual(mergeAgents([], [ATTACHED]), [ATTACHED]);
});

// --- an agent pane must never hide why it stopped ---

test("a clean exit after real work counts as finishing", () => {
  const exit = describeAgentExit(0, 45_000);
  assert.equal(exit.failed, false);
  assert.match(exit.message, /ended after 45s/);
});

test("a non-zero code is a failure however long it ran", () => {
  const exit = describeAgentExit(1, 60_000);
  assert.equal(exit.failed, true);
  assert.match(exit.message, /code 1/);
});

test("exiting immediately is a failure even with code 0", () => {
  // A provider that cannot start exits cleanly and at once. Reporting that as a normal
  // finish would hide the only thing worth knowing. The message points at the pane's own
  // output rather than naming a cause: the first guess at that cause was "out of quota",
  // and the real one turned out to be a bad --resume argument.
  const exit = describeAgentExit(0, 300);
  assert.equal(exit.failed, true);
  assert.match(exit.message, /Exited immediately/);
  assert.match(exit.message, /output above/);
});

test("the immediate-failure boundary is the documented one", () => {
  assert.equal(describeAgentExit(0, AGENT_FAILED_BEFORE_MS - 1).failed, true);
  assert.equal(describeAgentExit(0, AGENT_FAILED_BEFORE_MS).failed, false);
});

test("a missing exit code never renders as the word undefined", () => {
  for (const code of [undefined, null, Number.NaN, "1"]) {
    const exit = describeAgentExit(code, 30_000);
    assert.equal(exit.message.includes("undefined"), false, JSON.stringify(code));
    assert.equal(exit.message.includes("NaN"), false, JSON.stringify(code));
  }
  assert.equal(describeAgentExit(undefined, 300).failed, true, "an immediate exit is still a failure");
});
