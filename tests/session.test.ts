import test from "node:test";
import assert from "node:assert/strict";

import {
  appendUserTurn,
  emptySession,
  railActivity,
  reduceCodex,
  reduceSession,
  splitLines,
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

/**
 * stdout arrives in whatever chunks the OS hands over, so a JSON line is routinely split
 * across two reads. Everything above assumes whole lines; this is what guarantees them.
 */
test("a whole line is emitted and nothing is held back", () => {
  const { lines, rest } = splitLines("", '{"a":1}\n');
  assert.deepEqual(lines, ['{"a":1}']);
  assert.equal(rest, "");
});

test("a partial line is held until the rest of it arrives", () => {
  const first = splitLines("", '{"a":');
  assert.deepEqual(first.lines, [], "nothing is emitted from half a line");

  const second = splitLines(first.rest, '1}\n');
  assert.deepEqual(second.lines, ['{"a":1}']);
});

test("several lines in one chunk are all emitted", () => {
  const { lines } = splitLines("", '{"a":1}\n{"b":2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("carriage returns and blank lines are not emitted as lines", () => {
  const { lines } = splitLines("", '{"a":1}\r\n\r\n{"b":2}\r\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

/**
 * The stream's own `user` events are tool results, not what the human typed, so the
 * transcript would otherwise show only one side of the conversation. The manager knows
 * what it sent and appends it here.
 */
test("a user turn is appended and marks the session working", () => {
  const state = appendUserTurn(feed([init()]), "do the thing");
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]?.role, "user");
  assert.equal(state.turns[0]?.text, "do the thing");
  assert.equal(state.activity, "working");
});

test("a tool result on the stream does not become a user turn", () => {
  const state = feed([
    init(),
    line({
      type: "user",
      session_id: "s-1",
      message: { role: "user", content: [{ type: "tool_result", content: "hi" }] }
    })
  ]);
  assert.equal(state.turns.length, 0, "tool results are not the human speaking");
});

/**
 * Observed on a real run: a subagent's own messages arrive on the same stream, carrying
 * `parent_tool_use_id`. Folded in blindly they become main-thread turns, so the
 * transcript shows the subagent's Glob calls as though the top-level agent made them.
 */
test("a subagent's messages do not enter the main transcript", () => {
  const state = feed([
    init(),
    assistantText("delegating"),
    line({
      type: "assistant",
      session_id: "s-1",
      parent_tool_use_id: "toolu_01abc",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Glob", input: { pattern: "*.ts" } }]
      }
    })
  ]);
  assert.equal(state.turns.length, 1, "only the top-level message is a turn");
  assert.deepEqual(state.turns[0]?.tools, [], "the subagent's tools are not the agent's");
});

/*
 * Codex speaks a different vocabulary from Claude and has a different session model:
 * `codex exec` runs one turn per process, resumed by thread id. Shapes below are from a
 * real `codex exec --json` capture, not from documentation.
 */
function codex(event: unknown): string {
  return JSON.stringify(event);
}

test("thread.started records the thread as the session id", () => {
  const state = reduceCodex(emptySession(), codex({ type: "thread.started", thread_id: "01a0-thread" }));
  assert.equal(state.sessionId, "01a0-thread");
});

test("an agent_message item becomes an assistant turn", () => {
  const state = [
    codex({ type: "thread.started", thread_id: "t" }),
    codex({ type: "turn.started" }),
    codex({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } })
  ].reduce(reduceCodex, emptySession());
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0]?.role, "assistant");
  assert.equal(state.turns[0]?.text, "ok");
});

test("turn.started is working and turn.completed is idle", () => {
  const working = reduceCodex(emptySession(), codex({ type: "turn.started" }));
  assert.equal(working.activity, "working");
  const done = reduceCodex(working, codex({ type: "turn.completed", usage: { input_tokens: 1 } }));
  assert.equal(done.activity, "idle");
});

/** Observed: Codex reports non-fatal warnings as completed items of type `error`. */
test("an error item is a status detail, not a turn", () => {
  const state = reduceCodex(
    emptySession(),
    codex({ type: "item.completed", item: { id: "item_0", type: "error", message: "skills shortened" } })
  );
  assert.equal(state.turns.length, 0);
  assert.equal(state.statusDetail, "skills shortened");
});

test("turn.failed reports why and stops claiming to be working", () => {
  const state = reduceCodex(
    reduceCodex(emptySession(), codex({ type: "turn.started" })),
    codex({ type: "turn.failed", error: { message: "400 invalid_request_error" } })
  );
  assert.equal(state.activity, "idle");
  assert.equal(state.statusDetail, "400 invalid_request_error");
});

test("an unrecognised codex item is ignored and returns the identical object", () => {
  const before = reduceCodex(emptySession(), codex({ type: "thread.started", thread_id: "t" }));
  assert.equal(reduceCodex(before, codex({ type: "item.completed", item: { type: "reasoning" } })), before);
  assert.equal(reduceCodex(before, "{not json"), before);
});

/**
 * Observed: Codex nests the real message as a JSON *string* inside `turn.failed.error
 * .message`. Rendered raw it fills the pane with a JSON dump; the sentence inside it is
 * the part a person can act on.
 */
test("a codex failure shows its message, not its JSON envelope", () => {
  const envelope = JSON.stringify({
    type: "error",
    status: 400,
    error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model requires a newer version of Codex." }
  });
  const state = reduceCodex(emptySession(), codex({ type: "turn.failed", error: { message: envelope } }));
  assert.equal(state.statusDetail, "The 'gpt-6-astra' model requires a newer version of Codex.");
});

test("a codex failure that is not JSON is shown as written", () => {
  const state = reduceCodex(emptySession(), codex({ type: "turn.failed", error: { message: "network unreachable" } }));
  assert.equal(state.statusDetail, "network unreachable");
});

/*
 * The rail speaks the vocabulary hooks used to supply. A native session has to be
 * translated into it, and the translation is where a status panel starts lying if it
 * guesses — so `starting` stays `unknown` rather than becoming `idle`.
 */
test("session activity maps onto the rail's vocabulary", () => {
  assert.equal(railActivity("starting"), "unknown");
  assert.equal(railActivity("working"), "working");
  assert.equal(railActivity("idle"), "idle");
});

test("needing the human is waiting for input, not a permission prompt", () => {
  assert.equal(railActivity("needsAction"), "waitingForInput");
});

/*
 * M8 — showing what an agent is busy with — used to come from SubagentStart/Stop hooks.
 * On the stream the same facts arrive as an `Agent` tool call and the messages that
 * carry its id as `parent_tool_use_id`. Tool name and payload shape are from a real run.
 */
function agentCall(id: string, subagentType?: string): string {
  return line({
    type: "assistant",
    session_id: "s-1",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Agent", input: subagentType === undefined ? {} : { subagent_type: subagentType } }]
    }
  });
}

function toolResult(id: string): string {
  return line({
    type: "user",
    session_id: "s-1",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id }] }
  });
}

test("an Agent tool call starts a subagent named by its type", () => {
  const state = feed([init(), agentCall("toolu_1", "Explore")]);
  assert.equal(state.subagents.active, 1);
  assert.deepEqual(state.subagents.labels, ["Explore"]);
});

test("an unnamed subagent still counts, under the tool's own name", () => {
  const state = feed([init(), agentCall("toolu_1")]);
  assert.equal(state.subagents.active, 1);
  assert.deepEqual(state.subagents.labels, ["Agent"]);
});

test("a subagent stops when its tool result comes back", () => {
  const state = feed([init(), agentCall("toolu_1", "Explore"), toolResult("toolu_1")]);
  assert.equal(state.subagents.active, 0);
});

test("two subagents are tracked independently", () => {
  const state = feed([init(), agentCall("a", "Explore"), agentCall("b", "Plan"), toolResult("a")]);
  assert.equal(state.subagents.active, 1);
  assert.deepEqual(state.subagents.labels, ["Plan"]);
});

/** A turn ending with a subagent still marked running would leave the rail lying. */
test("a result clears any subagent still marked running", () => {
  const state = feed([init(), agentCall("toolu_1", "Explore"), line({ type: "result", subtype: "success" })]);
  assert.equal(state.subagents.active, 0);
});
