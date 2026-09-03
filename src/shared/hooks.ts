import type { AgentActivity } from "./agents.js";

/**
 * Per-launch hook configuration for an agent oikist starts.
 *
 * Written to a temporary settings file and passed as `claude --settings <path>`, so
 * nothing is ever written to `~/.claude/settings.json`. oikist changes nothing about how
 * Claude behaves outside oikist, and an agent started by hand is unaffected.
 */

/** The relay is launched with a fixed kind on argv, never one derived from a payload. */
export const HOOK_KINDS = Object.freeze({
  SessionStart: "session-start",
  UserPromptSubmit: "turn-start",
  PostToolUse: "tool-end",
  Stop: "turn-end",
  SessionEnd: "session-end"
} as const);

export type HookKind = (typeof HOOK_KINDS)[keyof typeof HOOK_KINDS] | "needs-permission";

/** `Notification` matches on notification type, so these are two separate entries. */
export const NOTIFICATION_MATCHERS = Object.freeze(["permission_prompt", "worker_permission_prompt"]);

/** A hook must never delay the agent it is attached to. */
export const HOOK_TIMEOUT_SECONDS = 10;

export interface HookHandler {
  readonly type: "command";
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

export interface HookSettings {
  readonly hooks: Record<string, readonly { readonly matcher?: string; readonly hooks: readonly HookHandler[] }[]>;
}

/**
 * Builds one hook handler in exec form.
 *
 * `command` plus `args` is not a shell string, so no character in a path, token or URL
 * can change what runs. The kind is fixed here at build time rather than read from the
 * hook payload, so a crafted payload cannot make the relay report a different event.
 */
export function hookHandler(
  nodePath: string,
  relayPath: string,
  kind: HookKind,
  endpoint: string,
  token: string
): HookHandler {
  return {
    type: "command",
    command: nodePath,
    args: [relayPath, "--kind", kind, "--endpoint", endpoint, "--token", token],
    timeout: HOOK_TIMEOUT_SECONDS
  };
}

export function buildHookSettings(
  nodePath: string,
  relayPath: string,
  endpoint: string,
  token: string
): HookSettings {
  const hooks: Record<string, { matcher?: string; hooks: HookHandler[] }[]> = {};
  for (const [event, kind] of Object.entries(HOOK_KINDS)) {
    hooks[event] = [{ hooks: [hookHandler(nodePath, relayPath, kind, endpoint, token)] }];
  }
  hooks.Notification = NOTIFICATION_MATCHERS.map((matcher) => ({
    matcher,
    hooks: [hookHandler(nodePath, relayPath, "needs-permission", endpoint, token)]
  }));
  return { hooks };
}

/**
 * What each hook event says the agent is now doing.
 *
 * `session-end` is absent on purpose: it retires the agent rather than moving it to a
 * state, and the caller handles that separately.
 */
const ACTIVITY_FOR_KIND: Readonly<Record<string, AgentActivity>> = Object.freeze({
  "session-start": "idle",
  "turn-start": "working",
  "tool-end": "working",
  "needs-permission": "needsPermission",
  "turn-end": "idle"
});

/**
 * Maps a hook kind to an activity, comparing against string literals rather than
 * indexing a lookup with untrusted input, so a value like `__proto__` selects nothing.
 */
export function activityForKind(kind: unknown): AgentActivity | null {
  if (typeof kind !== "string") {
    return null;
  }
  return Object.hasOwn(ACTIVITY_FOR_KIND, kind) ? (ACTIVITY_FOR_KIND[kind] ?? null) : null;
}

export function isSessionEnd(kind: unknown): boolean {
  return kind === "session-end";
}

export interface HookEvent {
  readonly sessionId: string;
  readonly kind: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every kind the relay is allowed to report. Anything else is refused, not coerced. */
const ALLOWED_KINDS: readonly string[] = [...Object.values(HOOK_KINDS), "needs-permission"];

/**
 * Validates a hook event posted to the loopback listener.
 *
 * The body reaches us from a separate process, so it is untrusted: the session id must
 * be a canonical UUID and the kind must be one this app defined. Unknown fields are
 * refused outright rather than ignored, so a payload shape change is loud.
 */
export function parseHookEvent(body: unknown): HookEvent | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("sessionId") || !keys.includes("kind")) {
    return null;
  }
  const { sessionId, kind } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) {
    return null;
  }
  if (typeof kind !== "string" || !ALLOWED_KINDS.includes(kind)) {
    return null;
  }
  return { sessionId, kind };
}
