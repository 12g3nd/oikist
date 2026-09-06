/**
 * A Claude session's state, reduced from the `stream-json` event stream.
 *
 * This is the replacement for reading a ConPTY grid: the agent is driven with
 * `--input-format stream-json --output-format stream-json`, and everything the UI shows
 * is folded out of the events below. Pure — no Node, no Electron, no filesystem — so it
 * is unit tested the same way `layout.ts` is.
 *
 * Two properties of the stream shaped this file, both established by experiment rather
 * than from documentation (see `docs/PHASE-2-native-agent-view.md`):
 *
 * - **`system/init` arrives once per turn, not once per session.** It reads like a
 *   session-open event and is not one. Resetting on it erases the transcript every time
 *   the user speaks.
 * - **The stream carries hook events oikist never registered**, because `--settings`
 *   merges with the user's global config rather than replacing it. They are labels from
 *   someone else's setup and are not this session's activity.
 *
 * Input is untrusted in the same sense a stored layout is — a truncated write or a newer
 * CLI emitting something unrecognised must cost that line and nothing more. Nothing here
 * throws, and an event that changes nothing returns the *identical* state object, so a
 * component reporting state upward cannot loop on it.
 */

export type SessionActivity = "starting" | "working" | "needsAction" | "idle";

export interface SessionTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  /** Names only. Tool input is prompt-adjacent text and is deliberately not kept. */
  readonly tools: readonly string[];
}

/** Utilisation is a fraction in 0..1, as the CLI reports it. */
export interface SessionLimits {
  readonly fiveHour: number;
  readonly sevenDay: number;
}

/** What the agent has delegated and not yet got back. */
export interface SessionSubagents {
  readonly active: number;
  /** Types of the running subagents, in the order they started. */
  readonly labels: readonly string[];
}

export interface SessionState {
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly slashCommands: readonly string[];
  readonly turns: readonly SessionTurn[];
  readonly activity: SessionActivity;
  readonly statusDetail: string | null;
  readonly limits: SessionLimits | null;
  readonly subagents: SessionSubagents;
  /**
   * Tool-call ids of the running subagents, in start order.
   *
   * Kept so a subagent can be retired when *its own* result returns rather than when any
   * result does — two running at once would otherwise stop each other's.
   */
  readonly subagentIds: readonly string[];
}

export function emptySession(): SessionState {
  return {
    sessionId: null,
    model: null,
    slashCommands: [],
    turns: [],
    activity: "starting",
    statusDetail: null,
    limits: null,
    subagents: { active: 0, labels: [] },
    subagentIds: []
  };
}

/**
 * Records a turn the human typed.
 *
 * The stream's own `user` events carry tool results rather than what was typed, so they
 * are ignored by `reduceSession` and the human's side of the transcript is added here,
 * by the caller that sent it.
 */
export function appendUserTurn(state: SessionState, text: string): SessionState {
  return {
    ...state,
    turns: [...state.turns, { role: "user", text, tools: [] }],
    activity: "working"
  };
}

/**
 * Folds one line of `codex exec --json` into the same state Claude produces.
 *
 * Codex speaks a different vocabulary — `thread.started`, `turn.started`,
 * `item.completed`, `turn.completed`, `turn.failed` — and has a different session model:
 * one process per turn, resumed by thread id, where Claude keeps one process for the
 * whole conversation. Both were established by capture rather than from documentation.
 *
 * Only the item types actually observed are handled. Anything else is ignored rather
 * than guessed at, and returns the identical object so it costs no re-render.
 */
/**
 * Digs the human sentence out of a Codex failure.
 *
 * Observed: the real message arrives as a JSON *string* nested inside
 * `turn.failed.error.message`, so rendering it directly fills the pane with an envelope
 * and buries the one line worth reading. Anything that is not that shape is returned
 * unchanged rather than mangled.
 */
function unwrapCodexError(message: string): string {
  try {
    const inner = asString(asRecord(asRecord(JSON.parse(message))?.error)?.message);
    return inner ?? message;
  } catch {
    return message;
  }
}

export function reduceCodex(state: SessionState, rawLine: string): SessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return state;
  }

  const event = asRecord(parsed);
  if (event === null) return state;

  switch (asString(event.type)) {
    case "thread.started": {
      const threadId = asString(event.thread_id);
      return threadId === null ? state : { ...state, sessionId: threadId };
    }
    case "turn.started":
      return { ...state, activity: "working" };
    case "turn.completed":
      return { ...state, activity: "idle" };
    case "turn.failed": {
      const message = asString(asRecord(event.error)?.message);
      return {
        ...state,
        activity: "idle",
        statusDetail: message === null ? state.statusDetail : unwrapCodexError(message)
      };
    }
    case "item.completed": {
      const item = asRecord(event.item);
      const itemType = asString(item?.type);
      if (itemType === "agent_message") {
        const text = asString(item?.text);
        if (text === null) return state;
        return { ...state, turns: [...state.turns, { role: "assistant", text, tools: [] }] };
      }
      if (itemType === "error") {
        // Observed carrying non-fatal warnings — a shortened skill budget, a missing
        // model description. Reported, but not as something the agent said.
        const message = asString(item?.message);
        return message === null ? state : { ...state, statusDetail: message };
      }
      return state;
    }
    default:
      return state;
  }
}

/**
 * Translates a session's activity into the vocabulary the agent rail speaks.
 *
 * The rail's words were designed around hook events; a native session has to be mapped
 * onto them. Two choices worth stating, because both are places a status panel could
 * quietly start lying:
 *
 * - `starting` becomes `unknown`, not `idle`. A session nobody has spoken to has said
 *   nothing, and `idle` would be a claim rather than an observation.
 * - `needsAction` becomes `waitingForInput`, not `needsPermission`. `post_turn_summary`
 *   says the human is needed; it does not say a permission prompt is open.
 */
export function railActivity(activity: SessionActivity): "working" | "idle" | "waitingForInput" | "unknown" {
  switch (activity) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "needsAction":
      return "waitingForInput";
    default:
      return "unknown";
  }
}

export interface SplitResult {
  readonly lines: readonly string[];
  /** The trailing fragment, if the chunk ended mid-line. Feed it back in as `held`. */
  readonly rest: string;
}

/**
 * Splits a stdout chunk into whole lines, carrying any partial line forward.
 *
 * The OS decides where reads break, so a JSON line is routinely delivered in two pieces.
 * Everything else in this file assumes whole lines; this is what guarantees them. `rest`
 * is deliberately left untrimmed — it may end mid-token, and trimming it could corrupt
 * the line once its remainder arrives.
 */
export function splitLines(held: string, chunk: string): SplitResult {
  const parts = (held + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts.map((part) => part.trim()).filter((part) => part !== ""),
    rest
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The tool that launches a subagent.
 *
 * Named from a real run: it is `Agent`, not `Task` — a probe looking for `Task` found
 * none at all while a subagent was demonstrably running.
 */
const SUBAGENT_TOOL = "Agent";

interface Started {
  readonly id: string;
  readonly label: string;
}

/** Splits an assistant message's content into text, tool names, and subagent starts. */
function readContent(message: unknown): { text: string; tools: string[]; started: Started[] } {
  const content = asRecord(message)?.content;
  const blocks = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const tools: string[] = [];
  const started: Started[] = [];

  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block === null) continue;
    if (block.type === "text") {
      const text = asString(block.text);
      if (text !== null) texts.push(text);
    } else if (block.type === "tool_use") {
      const name = asString(block.name);
      if (name === null) continue;
      tools.push(name);
      const id = asString(block.id);
      if (name === SUBAGENT_TOOL && id !== null) {
        // `subagent_type` is what the hook payload used to carry. When it is absent the
        // tool's own name is used rather than inventing a label.
        started.push({ id, label: asString(asRecord(block.input)?.subagent_type) ?? name });
      }
    }
  }

  return { text: texts.join(""), tools, started };
}

/** Ids of subagents whose results came back in this message. */
function finishedSubagents(message: unknown): string[] {
  const content = asRecord(message)?.content;
  const blocks = Array.isArray(content) ? content : [];
  const done: string[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block?.type !== "tool_result") continue;
    const id = asString(block.tool_use_id);
    if (id !== null) done.push(id);
  }
  return done;
}

function utilisation(window: unknown): number | null {
  const value = asRecord(window)?.utilization;
  return typeof value === "number" ? value : null;
}

/**
 * Folds one raw stdout line into the session state.
 *
 * Returns `state` itself for anything unparseable, unrecognised, or otherwise without
 * effect, so identity comparison is a valid "did anything change" test.
 */
export function reduceSession(state: SessionState, rawLine: string): SessionState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    return state;
  }

  const event = asRecord(parsed);
  if (event === null) return state;

  const type = asString(event.type);
  const subtype = asString(event.subtype);

  if (type === "system" && subtype === "init") {
    // Per turn, not per session: carry the transcript across.
    return {
      ...state,
      sessionId: asString(event.session_id) ?? state.sessionId,
      model: asString(event.model) ?? state.model,
      slashCommands: stringList(event.slash_commands),
      activity: "working"
    };
  }

  if (type === "assistant") {
    // A subagent's messages ride the same stream, marked by `parent_tool_use_id`. They
    // are work happening *inside* a tool call the agent already reported, so folding
    // them in as turns would show the subagent's tools as the agent's own.
    if (event.parent_tool_use_id != null) {
      return state.activity === "working" ? state : { ...state, activity: "working" };
    }
    const { text, tools, started } = readContent(event.message);
    const ids = [...state.subagentIds, ...started.map((one) => one.id)];
    const labels = [...state.subagents.labels, ...started.map((one) => one.label)];
    return {
      ...state,
      turns: [...state.turns, { role: "assistant", text, tools }],
      activity: "working",
      ...(started.length === 0
        ? {}
        : { subagentIds: ids, subagents: { active: ids.length, labels } })
    };
  }

  if (type === "system" && subtype === "post_turn_summary") {
    const needsAction = asString(event.needs_action) ?? "";
    return {
      ...state,
      statusDetail: asString(event.status_detail) ?? state.statusDetail,
      activity: needsAction === "" ? state.activity : "needsAction"
    };
  }

  if (type === "user") {
    // Tool results, including a subagent handing its work back.
    const done = finishedSubagents(event.message);
    if (done.length === 0) return state;
    const keep = state.subagentIds
      .map((id, index) => ({ id, label: state.subagents.labels[index] ?? SUBAGENT_TOOL }))
      .filter((one) => !done.includes(one.id));
    if (keep.length === state.subagentIds.length) return state;
    return {
      ...state,
      subagentIds: keep.map((one) => one.id),
      subagents: { active: keep.length, labels: keep.map((one) => one.label) }
    };
  }

  if (type === "result") {
    // A turn ended, so nothing it delegated is still running. A subagent left marked
    // active here would make the rail claim work that has stopped.
    const cleared = state.subagentIds.length === 0
      ? {}
      : { subagentIds: [], subagents: { active: 0, labels: [] } };
    // `needsAction` outranks the turn ending: the human is still owed something.
    if (state.activity === "needsAction") {
      return state.subagentIds.length === 0 ? state : { ...state, ...cleared };
    }
    return { ...state, ...cleared, activity: "idle" };
  }

  if (type === "rate_limit_event") {
    const windows = asRecord(asRecord(event.rate_limit_info)?.unifiedWindows);
    const fiveHour = utilisation(windows?.five_hour);
    const sevenDay = utilisation(windows?.seven_day);
    if (fiveHour === null || sevenDay === null) return state;
    return { ...state, limits: { fiveHour, sevenDay } };
  }

  // Hook events, and anything a future version introduces, are labels rather than
  // activity. Ignored on purpose, and cheaply: the same object comes back.
  return state;
}
