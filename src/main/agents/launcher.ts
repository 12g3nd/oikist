import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  activityForKind,
  buildHookSettings,
  isSessionEnd,
  isSubagentStart,
  isSubagentStop,
  type HookEvent
} from "../../shared/hooks.js";
import { projectFromCwd, type LaunchedAgent } from "../../shared/agents.js";

const run = promisify(execFile);

/**
 * Starts Claude sessions that oikist owns, and tracks what their hooks report.
 *
 * Two things make an owned agent different from a discovered one, and both come from
 * the launch: the session id is *assigned* with `--session-id` rather than recovered,
 * and hooks are installed per launch with `--settings`. Nothing is written to
 * `~/.claude/settings.json`, so an agent started by hand behaves exactly as it did
 * before oikist existed.
 */
export class AgentLauncher {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #launched = new Map<string, LaunchedAgent>();
  #settingsDir: string | null = null;
  #nodePath: string | null | undefined;

  constructor(endpoint: string, token: string) {
    this.#endpoint = endpoint;
    this.#token = token;
  }

  get agents(): LaunchedAgent[] {
    return [...this.#launched.values()];
  }

  /**
   * Finds a real Node binary for the hook relay.
   *
   * `process.execPath` is Electron here, and Electron only behaves as Node with an
   * environment variable that a hook definition cannot set. Resolved once and cached;
   * `null` means hooks cannot be installed and the caller degrades accordingly.
   */
  async #resolveNode(): Promise<string | null> {
    this.#nodePath ??= await this.#resolveExecutable("node");
    return this.#nodePath;
  }

  /**
   * Finds an executable on PATH.
   *
   * node-pty needs a real path: unlike `child_process` it does not search PATH, and a
   * bare name fails with an unhelpful "File not found". Only `.exe` results are taken,
   * since a `.cmd` shim is a batch file node-pty cannot execute directly either.
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
   * Builds the argv for a new owned Claude session.
   *
   * Returns the arguments only — the caller spawns them into a pty, so the agent is a
   * visible pane rather than a hidden process. If no Node can be found the session is
   * still launched, without hooks: an agent you can see and type into is worth more
   * than no agent, and the rail reports the reduced confidence rather than pretending.
   */
  async prepare(
    cwd?: string,
    resumeSessionId?: string
  ): Promise<{ sessionId: string; file: string; args: string[]; hooked: boolean }> {
    const file = await this.#resolveExecutable("claude");
    if (file === null) {
      throw new Error("Claude was not found on PATH. Install Claude Code, or open a shell pane instead.");
    }

    // Resuming keeps the session's identity; starting fresh assigns one. Either way the
    // id is known before the process exists, so nothing has to be recovered later.
    const sessionId = resumeSessionId ?? randomUUID();
    const args = resumeSessionId === undefined
      ? ["--session-id", sessionId]
      : ["--resume", resumeSessionId];
    let hooked = false;

    const nodePath = await this.#resolveNode();
    if (nodePath !== null) {
      try {
        this.#settingsDir ??= await mkdtemp(join(tmpdir(), "oikist-hooks-"));
        // Resolved from the built main bundle at out/main/index.js, so `../../` is the
        // app root. Existence is checked rather than assumed: a wrong path here fails
        // silently as a hook error inside the agent, where it is easy to miss.
        const relayPath = fileURLToPath(new URL("../../resources/hook-relay.mjs", import.meta.url));
        await access(relayPath, constants.R_OK);
        const settingsPath = join(this.#settingsDir, `${sessionId}.json`);
        const settings = buildHookSettings(nodePath, relayPath, this.#endpoint, this.#token);
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
        args.push("--settings", settingsPath);
        hooked = true;
      } catch {
        // Fall through unhooked rather than failing the launch.
      }
    }

    this.#launched.set(sessionId, {
      sessionId,
      // Claude has not spoken yet. `idle` would be a claim; this is honest until the
      // first hook arrives, and for an unhooked session it stays honest permanently.
      activity: "unknown",
      startedAt: Date.now(),
      ...(cwd === undefined ? {} : { cwd, title: projectFromCwd(cwd) })
    });

    return { sessionId, file, args, hooked };
  }

  /**
   * Prepares a native agent pane — one driven over stream-json rather than a pty.
   *
   * Deliberately thinner than `prepare`: no `--settings`, because a native session takes
   * its state from the event stream itself. Activity, limits and the turn list all
   * arrive inline, so the hook relay has nothing left to carry.
   *
   * The one thing hooks still do that the stream has not been shown to do is name a
   * subagent, so `prepare` and its settings file stay until that is settled. See
   * `docs/PHASE-2-native-agent-view.md`.
   */
  async prepareSession(
    cwd?: string,
    resumeSessionId?: string
  ): Promise<{ sessionId: string; file: string }> {
    const file = await this.#resolveExecutable("claude");
    if (file === null) {
      throw new Error("Claude was not found on PATH. Install Claude Code, or open a shell pane instead.");
    }

    const sessionId = resumeSessionId ?? randomUUID();
    this.#launched.set(sessionId, {
      sessionId,
      // Honest until the stream says otherwise, exactly as `prepare` is.
      activity: "unknown",
      startedAt: Date.now(),
      ...(cwd === undefined ? {} : { cwd, title: projectFromCwd(cwd) })
    });

    return { sessionId, file };
  }

  /**
   * Starts a Codex session that oikist owns.
   *
   * Far less is possible here than for Claude, and the difference is the platform's, not
   * a shortcut. Codex has no `--session-id` to assign and no hook surface to install, and
   * `codex app-server daemon` is Unix-only — so an app-server instance sees only threads
   * it loaded itself, and a TUI running in a pane is invisible to one. oikist therefore
   * knows it started this agent and nothing about what it is doing.
   *
   * The id below is oikist's own handle for the row, not a Codex thread id. It is never
   * shown as one and never used to resume: a dormant Codex pane starts a new session,
   * which is why `prepareCodex` takes no resume argument.
   */
  async prepareCodex(cwd?: string): Promise<{ sessionId: string; file: string; args: string[] }> {
    const file = await this.#resolveExecutable("codex");
    if (file === null) {
      throw new Error("Codex was not found on PATH. Install the Codex CLI, or open a shell pane instead.");
    }

    const sessionId = randomUUID();
    this.#launched.set(sessionId, {
      provider: "codex",
      sessionId,
      // Permanently unknown, not "not yet known". Nothing will ever arrive to change it.
      activity: "unknown",
      startedAt: Date.now(),
      // Always titled, so the row never falls back to showing this id. It is oikist's
      // own handle, and a hex string in the rail reads like a Codex thread id that
      // could be looked up — which it is not.
      title: cwd === undefined ? "codex" : projectFromCwd(cwd),
      ...(cwd === undefined ? {} : { cwd })
    });

    return { sessionId, file, args: [] };
  }

  /**
   * Tracks running subagents by counting starts against stops.
   *
   * The count is floored at zero rather than allowed to go negative: a stop whose start
   * was missed — the app opened mid-turn, or a hook was dropped — must not leave the
   * rail claiming minus one subagent forever.
   */
  #applySubagent(existing: LaunchedAgent, event: HookEvent): LaunchedAgent {
    const current = existing.subagents ?? { active: 0, labels: [] };
    if (isSubagentStart(event.kind)) {
      return {
        ...existing,
        subagents: {
          active: current.active + 1,
          labels: event.label === undefined ? [...current.labels] : [...current.labels, event.label]
        }
      };
    }

    const labels = [...current.labels];
    if (event.label !== undefined) {
      const at = labels.indexOf(event.label);
      if (at !== -1) {
        labels.splice(at, 1);
      }
    } else {
      labels.pop();
    }
    return { ...existing, subagents: { active: Math.max(0, current.active - 1), labels } };
  }

  /** Applies one hook event. Returns true when the rail should be republished. */
  applyHookEvent(event: HookEvent): boolean {
    const existing = this.#launched.get(event.sessionId);
    if (existing === undefined) {
      // A hook from a session this process did not launch — a leftover settings file
      // from a previous run, most likely. Ignored rather than inventing a row: oikist
      // knows nothing else about it, and a row with no cwd or name helps no one.
      return false;
    }
    if (isSessionEnd(event.kind)) {
      this.#launched.delete(event.sessionId);
      return true;
    }
    if (isSubagentStart(event.kind) || isSubagentStop(event.kind)) {
      this.#launched.set(event.sessionId, this.#applySubagent(existing, event));
      return true;
    }
    const activity = activityForKind(event.kind);
    if (activity === null || activity === existing.activity) {
      return false;
    }
    this.#launched.set(event.sessionId, { ...existing, activity });
    return true;
  }

  /** Called when a pane closes, so a killed agent leaves the rail. */
  forget(sessionId: string): boolean {
    return this.#launched.delete(sessionId);
  }

  /**
   * Removes hook settings directories left by earlier runs.
   *
   * `dispose` clears the current run's directory on a clean quit, but a killed process
   * leaves its behind — and each holds a settings file naming a bearer token. Eleven had
   * accumulated after a day of testing. Only directories older than a day are touched,
   * so a second instance running right now keeps its own.
   */
  static async sweepStaleSettings(): Promise<number> {
    const root = tmpdir();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
      for (const name of await readdir(root)) {
        if (!name.startsWith("oikist-hooks-")) {
          continue;
        }
        const path = join(root, name);
        try {
          if ((await stat(path)).mtimeMs < cutoff) {
            await rm(path, { recursive: true, force: true });
            removed += 1;
          }
        } catch {
          // A directory that vanished or is not ours to remove; skip it.
        }
      }
    } catch {
      // No temp directory to read is not a reason to fail startup.
    }
    return removed;
  }

  async dispose(): Promise<void> {
    this.#launched.clear();
    if (this.#settingsDir !== null) {
      // Each file carries a live token; they do not outlive the run that issued it.
      await rm(this.#settingsDir, { recursive: true, force: true }).catch(() => {});
      this.#settingsDir = null;
    }
  }
}
