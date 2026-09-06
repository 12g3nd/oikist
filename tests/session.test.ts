import test from "node:test";
import assert from "node:assert/strict";

import {
  emptySession,
  reduceSession,
  type SessionState
} from "../src/shared/session.js";

/** One JSONL line, the way the CLI writes it. */
function line(event: unknown): string {
  return JSON.stringify(event);
}

function init(overrides: Record<string, unknown> = {}): string {
  return line({
    type: "system",
    subtype: "init",
    session_id: "s-1",
    model: "claude-opus-5",
    slash_commands: ["model", "resume"],
    ...overrides
  });
}

function assistantText(text: string): string {
  return line({
    type: "assistant",
    session_id: "s-1",
    message: { role: "assistant", content: [{ type: "text", text }] }
  });
}

function feed(lines: readonly string[]): SessionState {
  return lines.reduce(reduceSession, emptySession());
}

test("init records the session id, model and slash commands", () => {
  const state = feed([init()]);
  assert.equal(state.sessionId, "s-1");
  assert.equal(state.model, "claude-opus-5");
  assert.deepEqual(state.slashCommands, ["model", "resume"]);
});

/**
 * The finding from task 2, and the reason this file exists. `system/init` arrives once
 * per *turn*, not once per session, so treating it as session-open would erase the
 * conversation on every turn the user takes.
 */
test("a second init keeps the turns already collected", () => {
  const state = feed([init(), assistantText("first"), init()]);
  assert.equal(state.turns.length, 1, "the second init must not reset the transcript");
  assert.equal(state.turns[0]?.text, "first");
});

test("an assistant message appends a turn carrying its text", () => {
  const state = feed([init(), assistantText("hello")]);
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]?.role, "assistant");
  assert.equal(state.turns[0]?.text, "hello");
});

test("an assistant message records the tools it called", () => {
  const state = feed([
    init(),
    line({
      type: "assistant",
      session_id: "s-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "running it" },
          { type: "tool_use", name: "Bash", input: { command: "echo hi" } }
        ]
      }
    })
  ]);
  assert.deepEqual(state.turns[0]?.tools, ["Bash"]);
  assert.equal(state.turns[0]?.text, "running it", "tool blocks do not become text");
});

test("a turn is working until its result arrives, then idle", () => {
  const working = feed([init(), assistantText("thinking")]);
  assert.equal(working.activity, "working");

  const done = reduceSession(working, line({ type: "result", subtype: "success", session_id: "s-1" }));
  assert.equal(done.activity, "idle");
});

test("post_turn_summary with needs_action marks the session as needing the human", () => {
  const state = feed([
    init(),
    line({
      type: "system",
      subtype: "post_turn_summary",
      session_id: "s-1",
      status_category: "input_needed",
      status_detail: "waiting on a choice",
      needs_action: "pick an option"
    })
  ]);
  assert.equal(state.activity, "needsAction");
  assert.equal(state.statusDetail, "waiting on a choice");
});

test("an empty needs_action does not claim the human is needed", () => {
  const state = feed([
    init(),
    line({
      type: "system",
      subtype: "post_turn_summary",
      session_id: "s-1",
      status_category: "review_ready",
      status_detail: "replied as requested",
      needs_action: ""
    })
  ]);
  assert.notEqual(state.activity, "needsAction");
});

test("rate_limit_event records both windows", () => {
  const state = feed([
    init(),
    line({
      type: "rate_limit_event",
      session_id: "s-1",
      rate_limit_info: {
        unifiedWindows: {
          five_hour: { utilization: 0.22, resetsAt: 1788679800 },
          seven_day: { utilization: 0.69, resetsAt: 1788789600 }
        }
      }
    })
  ]);
  assert.equal(state.limits?.fiveHour, 0.22);
  assert.equal(state.limits?.sevenDay, 0.69);
});

/**
 * Stdout is untrusted in the same way a stored layout is: a truncated write or a version
 * that emits something new must cost that line, never the session.
 */
test("a malformed line is dropped rather than thrown", () => {
  const before = feed([init(), assistantText("kept")]);
  const after = reduceSession(before, "{not json");
  assert.equal(after.turns.length, 1);
});

test("an unknown event type is ignored", () => {
  const before = feed([init()]);
  const after = reduceSession(before, line({ type: "something_new", session_id: "s-1" }));
  assert.equal(after.sessionId, "s-1");
});

/**
 * A reducer that rebuilds state for an unchanged value makes a component reporting state
 * upward loop forever: report, re-render, report again. This has already bitten in
 * `layout.ts`; the same rule holds here.
 */
test("an ignored event returns the identical object", () => {
  const before = feed([init()]);
  assert.equal(reduceSession(before, "{not json"), before);
  assert.equal(reduceSession(before, line({ type: "something_new" })), before);
});

/**
 * Task 1: `--settings` merges with the user's global config rather than replacing it, so
 * the stream carries hook events oikist did not register. They name the user's own setup
 * and must not surface as oikist activity.
 */
test("hook events are not turns", () => {
  const state = feed([
    init(),
    line({
      type: "system",
      subtype: "hook_started",
      session_id: "s-1",
      hook_name: "SessionStart:startup",
      hook_event: "SessionStart"
    })
  ]);
  assert.equal(state.turns.length, 0);
});
