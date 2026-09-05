/**
 * The agent model.
 *
 * Kept pure so it can be tested without spawning a provider. Everything here treats its
 * input as untrusted: it is the parsed stdout of a third-party CLI whose shape is not
 * a stable contract, and a change in it must cost a row in the rail rather than the
 * app's ability to start.
 */

export type AgentProvider = "claude" | "codex";

export type AgentActivity = "needsPermission" | "waitingForInput" | "working" | "idle" | "unknown";

/**
 * How an agent came to be known, and therefore how much its state can be trusted.
 *
 * `launched` means oikist started it, so its identity is certain. `attached` means it
 * was found running: its identity is real, but nothing has told us what it is doing.
 * The UI shows the difference rather than flattening it, because a confident guess
 * presented as fact is how a status panel stops being believed.
 *
 * Origin is about identity, never about activity. A launched Claude usually also
 * reports its state through hooks, but a launched Codex never does — Codex publishes no
 * live state for a TUI session on Windows — and an unhooked Claude launch does not
 * either. Those rows are `launched` and `unknown` at the same time, which is the honest
 * pair rather than a contradiction.
 */
export type AgentOrigin = "launched" | "attached";
export type AgentConfidence = "certain" | "confident";

export interface AgentSummary {
  readonly provider: AgentProvider;
  readonly sessionId: string;
  readonly activity: AgentActivity;
  readonly origin: AgentOrigin;
  readonly confidence: AgentConfidence;
  readonly title: string;
  readonly startedAt: number;
  readonly pid?: number;
  readonly cwd?: string;
  readonly project?: string;
  /** Subagents this agent is running right now, when it reports them. */
  readonly subagents?: SubagentView;
}

export interface SubagentView {
  readonly active: number;
  /** Types of the running subagents, when the payload named them. */
  readonly labels: readonly string[];
}

/** Attention first. The rail's whole purpose is that the top row is the one that needs you. */
export const ATTENTION_ORDER: readonly AgentActivity[] = [
  "needsPermission",
  "waitingForInput",
  "working",
  "idle",
  "unknown"
];

export function compareAgents(a: AgentSummary, b: AgentSummary): number {
  const byAttention = ATTENTION_ORDER.indexOf(a.activity) - ATTENTION_ORDER.indexOf(b.activity);
  // Within a state, most recently started first: that is the one you were just looking at.
  return byAttention !== 0 ? byAttention : b.startedAt - a.startedAt;
}

/** The trailing directory name, which is what a person calls the project. */
export function projectFromCwd(cwd: string): string {
  return cwd.split(/[\\/]+/).filter((segment) => segment !== "" && !segment.endsWith(":")).at(-1) ?? "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAgent(value: unknown): AgentSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const { sessionId, pid, cwd, startedAt, name } = value;
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) {
    return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (typeof cwd !== "string" || cwd === "") {
    return null;
  }

  const project = projectFromCwd(cwd);
  return {
    provider: "claude",
    sessionId,
    pid,
    cwd,
    project,
    // An agent with no name still needs something to click on; the project is the most
    // useful thing we already know about it.
    title: typeof name === "string" && name !== "" ? name : project,
    startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : 0,
    origin: "attached",
    confidence: "confident",
    // Identity is not activity. `claude agents --json` reports which sessions exist,
    // never what they are doing, and this Claude version no longer writes status to its
    // live-session files. Only a hook from an agent oikist launched can say more.
    activity: "unknown"
  };
}

/** Parses the output of `claude agents --json`. */
export function parseClaudeAgents(value: unknown): AgentSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const agents: AgentSummary[] = [];
  for (const entry of value) {
    const agent = readAgent(entry);
    if (agent === null || seen.has(agent.sessionId)) {
      continue;
    }
    seen.add(agent.sessionId);
    agents.push(agent);
  }
  return agents.sort(compareAgents);
}

/**
 * State oikist knows about an agent it started itself.
 *
 * Reported by that agent's own hooks rather than inferred, which is why these rows are
 * `certain` while discovered ones are only `confident`.
 */
export interface LaunchedAgent {
  /**
   * Absent means Claude, so every launch that predates a second provider still reads
   * correctly. Codex rows set it explicitly.
   */
  readonly provider?: AgentProvider;
  readonly sessionId: string;
  readonly activity: AgentActivity;
  readonly startedAt: number;
  readonly cwd?: string;
  readonly title?: string;
  readonly subagents?: SubagentView;
}

/**
 * Merges agents oikist launched with agents it merely found.
 *
 * A launched agent always wins: it has hooks and reports its own state, so anything the
 * poller says about the same session is strictly worse information. Discovery still
 * contributes the pid and the name it knows, which a launched record may not carry yet.
 */
export function mergeAgents(
  launched: readonly LaunchedAgent[],
  attached: readonly AgentSummary[]
): AgentSummary[] {
  const byId = new Map<string, AgentSummary>();
  for (const agent of attached) {
    byId.set(agent.sessionId, agent);
  }
  for (const own of launched) {
    const discovered = byId.get(own.sessionId);
    const cwd = own.cwd ?? discovered?.cwd;
    const project = cwd === undefined ? discovered?.project : projectFromCwd(cwd);
    byId.set(own.sessionId, {
      provider: own.provider ?? "claude",
      sessionId: own.sessionId,
      activity: own.activity,
      origin: "launched",
      confidence: "certain",
      title: own.title ?? discovered?.title ?? project ?? own.sessionId.slice(0, 8),
      startedAt: own.startedAt || (discovered?.startedAt ?? 0),
      ...(discovered?.pid === undefined ? {} : { pid: discovered.pid }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(project === undefined || project === "" ? {} : { project }),
      ...(own.subagents === undefined || own.subagents.active === 0 ? {} : { subagents: own.subagents })
    });
  }
  return [...byId.values()].sort(compareAgents);
}

/** How long a session must last before ending counts as finishing rather than failing. */
export const AGENT_FAILED_BEFORE_MS = 2000;

export interface AgentExit {
  readonly failed: boolean;
  readonly message: string;
}

/**
 * Describes why an agent session ended.
 *
 * Two things mean failure rather than completion: a non-zero exit code, and ending
 * almost immediately. The second matters because a provider that is out of quota exits
 * cleanly and at once — code 0, under a second — and calling that "finished" would hide
 * the only thing the user needs to know.
 */
export function describeAgentExit(exitCode: unknown, ranForMs: number): AgentExit {
  const seconds = Math.max(0, Math.round(ranForMs / 1000));
  // node-pty does not always supply one; "code undefined" tells the reader nothing.
  const code = typeof exitCode === "number" && Number.isFinite(exitCode) ? exitCode : null;
  if (ranForMs < AGENT_FAILED_BEFORE_MS) {
    return {
      failed: true,
      message:
        code === 0 || code === null
          ? "Exited immediately. The output above is usually the reason."
          : `Exited immediately with code ${code}.`
    };
  }
  if (code !== 0 && code !== null) {
    return { failed: true, message: `Exited with code ${code} after ${seconds}s.` };
  }
  return { failed: false, message: `Session ended after ${seconds}s.` };
}
