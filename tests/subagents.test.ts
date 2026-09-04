import test from "node:test";
import assert from "node:assert/strict";

import { AgentLauncher } from "../src/main/agents/launcher.js";
import { MAX_LABEL_LENGTH, parseHookEvent } from "../src/shared/hooks.js";

const SESSION = "310ff72c-7a29-4972-acc8-edb59ebee744";

test("a subagent label is accepted and cleaned", () => {
  const event = parseHookEvent({ sessionId: SESSION, kind: "subagent-start", label: "code-reviewer" });
  assert.deepEqual(event, { sessionId: SESSION, kind: "subagent-start", label: "code-reviewer" });
});

test("control characters are stripped from a label, since it reaches the UI", () => {
  const dirty = `code${String.fromCharCode(7)}review${String.fromCharCode(27)}`;
  const event = parseHookEvent({ sessionId: SESSION, kind: "subagent-start", label: dirty });
  assert.equal(event?.label, "codereview");
});

test("an over-long label is capped rather than allowed to break the rail", () => {
  const event = parseHookEvent({ sessionId: SESSION, kind: "subagent-start", label: "x".repeat(500) });
  assert.equal(event?.label?.length, MAX_LABEL_LENGTH);
});

test("an empty or whitespace label is dropped rather than rendered blank", () => {
  assert.deepEqual(parseHookEvent({ sessionId: SESSION, kind: "subagent-start", label: "   " }), {
    sessionId: SESSION,
    kind: "subagent-start"
  });
});

test("a non-string label is refused outright", () => {
  assert.equal(parseHookEvent({ sessionId: SESSION, kind: "subagent-start", label: 7 }), null);
});

test("a field that is not sessionId, kind or label is still refused", () => {
  assert.equal(parseHookEvent({ sessionId: SESSION, kind: "subagent-start", other: "x" }), null);
});

test("both subagent kinds are allowed, and nothing invented is", () => {
  assert.ok(parseHookEvent({ sessionId: SESSION, kind: "subagent-start" }));
  assert.ok(parseHookEvent({ sessionId: SESSION, kind: "subagent-stop" }));
  assert.equal(parseHookEvent({ sessionId: SESSION, kind: "subagent-explode" }), null);
});

// `prepare()` resolves executables and writes a settings file but spawns nothing, so
// the counting is exercised for real rather than asserted about in a comment.

async function withLaunched(
  run: (launcher: AgentLauncher, sessionId: string) => void
): Promise<void> {
  const launcher = new AgentLauncher("http://127.0.0.1:1/hook", "t".repeat(64));
  try {
    const { sessionId } = await launcher.prepare("C:\Users\SJ\oikist");
    run(launcher, sessionId);
  } finally {
    await launcher.dispose();
  }
}

const subagentsOf = (launcher: AgentLauncher, sessionId: string) =>
  launcher.agents.find((agent) => agent.sessionId === sessionId)?.subagents;

test("starts and stops are counted, and labels track what is running", async () => {
  await withLaunched((launcher, sessionId) => {
    launcher.applyHookEvent({ sessionId, kind: "subagent-start", label: "explore" });
    launcher.applyHookEvent({ sessionId, kind: "subagent-start", label: "review" });
    assert.deepEqual(subagentsOf(launcher, sessionId), { active: 2, labels: ["explore", "review"] });

    launcher.applyHookEvent({ sessionId, kind: "subagent-stop", label: "explore" });
    assert.deepEqual(
      subagentsOf(launcher, sessionId),
      { active: 1, labels: ["review"] },
      "the finished subagent is the one removed, not simply the last"
    );
  });
});

test("a stop with no matching start cannot drive the count negative", async () => {
  await withLaunched((launcher, sessionId) => {
    launcher.applyHookEvent({ sessionId, kind: "subagent-stop" });
    launcher.applyHookEvent({ sessionId, kind: "subagent-stop" });
    assert.equal(
      subagentsOf(launcher, sessionId)?.active,
      0,
      "opening the app mid-turn must not leave the rail claiming minus one"
    );
  });
});

test("an unlabelled stop still decrements, so a count never sticks", async () => {
  await withLaunched((launcher, sessionId) => {
    launcher.applyHookEvent({ sessionId, kind: "subagent-start", label: "explore" });
    launcher.applyHookEvent({ sessionId, kind: "subagent-stop" });
    assert.equal(subagentsOf(launcher, sessionId)?.active, 0);
  });
});

test("a hook for a session oikist did not launch invents no row", async () => {
  const launcher = new AgentLauncher("http://127.0.0.1:1/hook", "t".repeat(64));
  assert.equal(launcher.applyHookEvent({ sessionId: SESSION, kind: "subagent-start" }), false);
  assert.deepEqual(launcher.agents, []);
  await launcher.dispose();
});

test("ending the session clears its subagents with it", async () => {
  await withLaunched((launcher, sessionId) => {
    launcher.applyHookEvent({ sessionId, kind: "subagent-start", label: "explore" });
    launcher.applyHookEvent({ sessionId, kind: "session-end" });
    assert.deepEqual(launcher.agents, []);
  });
});
