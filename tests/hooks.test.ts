import test from "node:test";
import assert from "node:assert/strict";

import {
  HOOK_KINDS,
  NOTIFICATION_MATCHERS,
  activityForKind,
  buildHookSettings,
  isSessionEnd,
  parseHookEvent
} from "../src/shared/hooks.js";

const SETTINGS = buildHookSettings("C:\\node.exe", "C:\\oikist\\relay.mjs", "http://127.0.0.1:5051/hook", "tok");
const SESSION = "310ff72c-7a29-4972-acc8-edb59ebee744";

test("every hook is exec form, so no path or token can be read as shell syntax", () => {
  const handlers = Object.values(SETTINGS.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.ok(handlers.length > 0);
  for (const handler of handlers) {
    assert.equal(handler.type, "command");
    assert.equal(handler.command, "C:\\node.exe");
    assert.ok(Array.isArray(handler.args));
    assert.equal(handler.args[0], "C:\\oikist\\relay.mjs");
    assert.ok(handler.timeout > 0, "a hook must never delay the agent indefinitely");
    // A single joined string anywhere would mean a shell could reinterpret it.
    assert.equal(handler.args.some((arg) => arg.includes(" -")), false);
  }
});

test("all five lifecycle events and both permission matchers are registered", () => {
  for (const event of Object.keys(HOOK_KINDS)) {
    assert.ok(SETTINGS.hooks[event], `${event} must be registered`);
  }
  const notification = SETTINGS.hooks.Notification!;
  assert.equal(notification.length, 2);
  assert.deepEqual(notification.map((group) => group.matcher), [...NOTIFICATION_MATCHERS]);
});

test("the kind is fixed on argv, never taken from the payload", () => {
  const kinds = Object.values(SETTINGS.hooks)
    .flatMap((groups) => groups.flatMap((group) => group.hooks))
    .map((handler) => handler.args[handler.args.indexOf("--kind") + 1]);
  assert.ok(kinds.includes("needs-permission"));
  assert.ok(kinds.includes("turn-start"));
  assert.equal(kinds.some((kind) => kind === undefined), false);
});

test("hook kinds map to activities, and session-end retires instead", () => {
  assert.equal(activityForKind("turn-start"), "working");
  assert.equal(activityForKind("tool-end"), "working");
  assert.equal(activityForKind("needs-permission"), "needsPermission");
  assert.equal(activityForKind("turn-end"), "idle");
  assert.equal(activityForKind("session-start"), "idle");

  assert.equal(activityForKind("session-end"), null);
  assert.equal(isSessionEnd("session-end"), true);
  assert.equal(isSessionEnd("turn-end"), false);
});

test("an unknown or hostile kind selects nothing", () => {
  for (const kind of ["__proto__", "constructor", "toString", "busy", "", null, 7, {}]) {
    assert.equal(activityForKind(kind), null, JSON.stringify(kind));
  }
});

test("a valid hook event is accepted", () => {
  assert.deepEqual(parseHookEvent({ sessionId: SESSION, kind: "turn-start" }), {
    sessionId: SESSION,
    kind: "turn-start"
  });
});

test("a body with unknown fields, a bad id, or a bad kind is refused", () => {
  for (const body of [
    { sessionId: SESSION, kind: "turn-start", extra: 1 },
    { sessionId: SESSION },
    { kind: "turn-start" },
    { sessionId: "not-a-uuid", kind: "turn-start" },
    { sessionId: SESSION, kind: "__proto__" },
    { sessionId: SESSION, kind: "arbitrary" },
    null,
    [],
    "text",
    42
  ]) {
    assert.equal(parseHookEvent(body), null, JSON.stringify(body));
  }
});

test("subagent events are registered, so a pane can report what it is busy with", () => {
  // Both names were confirmed valid by `claude doctor`, which prints its full event
  // list when it meets an unknown one, and confirmed live: a real session fired
  // subagent-start and subagent-stop with label "Explore".
  assert.ok(SETTINGS.hooks.SubagentStart, "SubagentStart must be registered");
  assert.ok(SETTINGS.hooks.SubagentStop, "SubagentStop must be registered");

  const kinds = Object.values(SETTINGS.hooks)
    .flatMap((groups) => groups.flatMap((group) => group.hooks))
    .map((handler) => handler.args[handler.args.indexOf("--kind") + 1]);
  assert.ok(kinds.includes("subagent-start"));
  assert.ok(kinds.includes("subagent-stop"));
});
