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

export interface SessionState {
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly slashCommands: readonly string[];
  readonly turns: readonly SessionTurn[];
  readonly activity: SessionActivity;
  readonly statusDetail: string | null;
  readonly limits: SessionLimits | null;
}

export function emptySession(): SessionState {
  return {
    sessionId: null,
    model: null,
    slashCommands: [],
    turns: [],
    activity: "starting",
    statusDetail: null,
    limits: null
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

/** Splits an assistant message's content into its visible text and the tools it called. */
function readContent(message: unknown): { text: string; tools: string[] } {
  const content = asRecord(message)?.content;
  const blocks = Array.isArray(content) ? content : [];
  const texts: string[] = [];
  const tools: string[] = [];

  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block === null) continue;
    if (block.type === "text") {
      const text = asString(block.text);
      if (text !== null) texts.push(text);
    } else if (block.type === "tool_use") {
      const name = asString(block.name);
      if (name !== null) tools.push(name);
    }
  }

  return { text: texts.join(""), tools };
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
    const { text, tools } = readContent(event.message);
    return {
      ...state,
      turns: [...state.turns, { role: "assistant", text, tools }],
      activity: "working"
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

  if (type === "result") {
    // A turn ended. `needsAction` outranks it: the human is still owed something.
    return state.activity === "needsAction" ? state : { ...state, activity: "idle" };
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
