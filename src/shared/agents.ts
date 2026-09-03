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
 * `launched` means oikist started it, assigned its session id, and installed hooks for
 * it — its state is reported, not inferred. `attached` means it was found running: its
 * identity is real, but nothing has told us what it is doing. The UI shows the
 * difference rather than flattening it, because a confident guess presented as fact is
 * how a status panel stops being believed.
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
