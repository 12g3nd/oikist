import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { projectFromCwd, type LaunchedAgent, type SubagentView } from "../../shared/agents.js";

const run = promisify(execFile);

/**
 * Starts agent sessions that oikist owns, and tracks what they report about themselves.
 *
 * An owned agent differs from a discovered one in that its identity comes from the launch
 * rather than being recovered afterwards, and that it reports its own state on its event
 * stream. Nothing is written to `~/.claude/settings.json` or `~/.codex/config.toml`, so
 * an agent started by hand behaves exactly as it did before oikist existed.
 *
 * There were hooks here once — a relay script, an ephemeral loopback listener, a bearer
 * token and a per-launch settings file — because the only way to learn what an agent was
 * doing was to have it phone home. A session driven over its own JSON event stream
 * publishes activity, limits and subagents directly, so all of that is gone. See
 * `docs/PHASE-2-native-agent-view.md`.
 */
export class AgentLauncher {
  readonly #launched = new Map<string, LaunchedAgent>();

  get agents(): LaunchedAgent[] {
    return [...this.#launched.values()];
  }

  /**
   * Finds an executable on PATH.
   *
   * A bare name is not enough: `where` is consulted so the child is spawned from an
   * absolute path, and only `.exe` results are taken, since a `.cmd` shim is a batch file
   * rather than something directly executable.
   */
  async #resolveExecutable(name: string): Promise<string | null> {
    try {
      const { stdout } = await run("where", [name], { windowsHide: true, timeout: 5_000 });
      return (
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.toLowerCase().endsWith(".exe")) ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Prepares an agent pane driven over its provider's JSON event stream.
   *
   * No settings file and no relay: the session reports its own activity, limits and
   * subagents inline.
   */
  async prepareSession(
    provider: "claude" | "codex",
    cwd?: string,
    resumeSessionId?: string
  ): Promise<{ sessionId: string; file: string }> {
    const file = await this.#resolveExecutable(provider);
    if (file === null) {
      throw new Error(
        provider === "codex"
          ? "Codex was not found on PATH. Install the Codex CLI, or open a shell pane instead."
          : "Claude was not found on PATH. Install Claude Code, or open a shell pane instead."
      );
    }

    /*
     * Claude's id is assigned by oikist with `--session-id`. Codex has no such flag: it
     * mints a thread id itself and announces it as `thread.started`, so the id below is
     * oikist's own handle until the real one arrives on the stream.
     */
    const sessionId = resumeSessionId ?? randomUUID();
    this.#launched.set(sessionId, {
      sessionId,
      provider,
      // Honest until the stream says otherwise. `idle` here would be a claim.
      activity: "unknown",
      startedAt: Date.now(),
      ...(cwd === undefined ? {} : { cwd, title: projectFromCwd(cwd) })
    });

    return { sessionId, file };
  }

  /**
   * Updates a row from a session's own reported state.
   *
   * The CLI publishes activity and running subagents itself, so nothing is inferred from
   * hook timing the way it once was. Returns whether the rail actually changed, so a
   * stream that keeps saying the same thing costs no re-render.
   */
  applySessionState(
    sessionId: string,
    activity: LaunchedAgent["activity"],
    subagents: SubagentView
  ): boolean {
    const existing = this.#launched.get(sessionId);
    if (existing === undefined) {
      return false;
    }
    const before = existing.subagents ?? { active: 0, labels: [] };
    const unchanged =
      existing.activity === activity &&
      before.active === subagents.active &&
      before.labels.join(",") === subagents.labels.join(",");
    if (unchanged) {
      return false;
    }
    this.#launched.set(sessionId, { ...existing, activity, subagents });
    return true;
  }

  /** Called when a pane closes, so a killed agent leaves the rail. */
  forget(sessionId: string): boolean {
    return this.#launched.delete(sessionId);
  }
}
