import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import {
  appendUserTurn,
  emptySession,
  reduceCodex,
  reduceSession,
  splitLines,
  type SessionState
} from "../shared/session.js";
import { IPC } from "../shared/ipc.js";

/**
 * Runs Claude sessions as native conversations rather than terminal panes.
 *
 * The agent is the same `claude` binary a shell would run — this is not the API and not
 * an SDK re-implementation — but it is driven over `--input-format stream-json
 * --output-format stream-json` instead of ConPTY. That is the whole point of the change:
 * a grid of characters has no caret, no cursor position to click, no rich input and no
 * attachments, and none of those can be added to it. See `docs/DECISIONS.md` section 10.
 *
 * One process serves a whole session. Verified rather than assumed: two turns over one
 * stdin pipe keep the process alive, report a single session id, and retain context.
 */

/** The binary is resolved to an absolute `.exe` by the caller; see `AgentLauncher`. */
export interface AgentSessionRequest {
  readonly provider: "claude" | "codex";
  readonly file: string;
  readonly cwd?: string;
  readonly sessionId: string;
  readonly resumeSessionId?: string;
}

/**
 * Two providers, two session models, both established by capture.
 *
 * Claude keeps **one process for the whole conversation**, fed turns over stdin as
 * stream-json. Codex runs **one process per turn**: `codex exec` takes a single prompt
 * and exits, and continuity comes from `codex exec resume <thread_id>`, which returns
 * the same thread id and retains context.
 *
 * So for Codex there is usually no child at all — `child` is null between turns, and a
 * process exiting is the end of a turn rather than the end of the session.
 */
interface LiveSession {
  readonly provider: "claude" | "codex";
  readonly file: string;
  readonly cwd?: string;
  readonly sessionId: string;
  child: ChildProcessWithoutNullStreams | null;
  /** Codex only: the thread to resume. Learned from the first `thread.started`. */
  threadId: string | null;
  /** The trailing fragment of a stdout chunk that ended mid-line. */
  held: string;
  state: SessionState;
}

export class AgentSessionManager {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #send: (channel: string, payload: unknown) => void;

  /**
   * `send` is injected rather than a WebContents captured directly, so the manager can
   * be exercised without an Electron window — the same shape `PtyManager` uses.
   */
  constructor(send: (channel: string, payload: unknown) => void) {
    this.#send = send;
  }

  static forWebContents(contents: WebContents): AgentSessionManager {
    return new AgentSessionManager((channel, payload) => {
      // A destroyed WebContents throws on send. A session outliving its window by a few
      // milliseconds during shutdown is normal and must not crash the main process.
      if (!contents.isDestroyed()) {
        contents.send(channel, payload);
      }
    });
  }

  /** The arguments that turn Claude into a stream-json conversation. */
  static argsFor(request: AgentSessionRequest): string[] {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
    if (request.resumeSessionId === undefined) {
      args.push("--session-id", request.sessionId);
    } else {
      args.push("--resume", request.resumeSessionId);
    }
    return args;
  }

  start(request: AgentSessionRequest): string {
    const id = randomUUID();
    const session: LiveSession = {
      provider: request.provider,
      file: request.file,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      sessionId: request.sessionId,
      child: null,
      threadId: request.provider === "codex" ? request.resumeSessionId ?? null : null,
      held: "",
      state: emptySession()
    };
    this.#sessions.set(id, session);

    // Codex has no process until a turn is sent: `codex exec` takes one prompt and
    // exits. Starting one now would run an empty turn and spend quota for nothing.
    if (request.provider === "claude") {
      this.#spawnClaude(id, session, request);
    }
    return id;
  }

  #spawnClaude(id: string, session: LiveSession, request: AgentSessionRequest): void {
    const child = spawn(session.file, AgentSessionManager.argsFor(request), {
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    session.child = child;
    this.#attach(id, session, child, true);
  }

  /**
   * Runs one Codex turn.
   *
   * `resume` carries the thread, which is how a conversation survives a process that
   * exits after every turn. Verified: resuming returns the same thread id and the model
   * still remembers the previous turn.
   *
   * The user's configured model is deliberately **not** overridden. If their config names
   * a model their CLI cannot run, `turn.failed` says so and the pane shows it — which is
   * more useful than oikist quietly substituting a different model than the one they
   * chose. Hard rule 4 is about not changing how Codex behaves; that applies to the model
   * as much as to the config file.
   */
  #spawnCodexTurn(id: string, session: LiveSession, text: string): void {
    const args = session.threadId === null
      ? ["exec", "--json", "--skip-git-repo-check", text]
      : ["exec", "resume", session.threadId, "--json", "--skip-git-repo-check", text];

    const child = spawn(session.file, args, {
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    session.child = child;
    // stdin is closed at once: with it open `codex exec` waits for more input and the
    // turn never starts, which cost a run to discover.
    child.stdin.end();
    this.#attach(id, session, child, false);
  }

  /**
   * Wires one child's output into the session.
   *
   * `endsSession` separates the two models: for Claude the process *is* the session, so
   * its exit ends the pane. For Codex the process is one turn, so its exit is ordinary
   * and the pane stays open for the next one.
   */
  #attach(
    id: string,
    session: LiveSession,
    child: ChildProcessWithoutNullStreams,
    endsSession: boolean
  ): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(id, chunk));

    // stderr is the CLI's own diagnostics, never conversation. It goes to the main
    // process log so a session that fails to start says why, rather than presenting as
    // a pane that does nothing.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text !== "") {
        console.error(`[agent ${session.sessionId}] ${text}`);
      }
    });

    child.on("exit", (code) => {
      session.held = "";
      if (session.child === child) {
        session.child = null;
      }
      if (endsSession) {
        this.#sessions.delete(id);
        this.#send(IPC.sessionExit, { id, exitCode: code ?? 0 });
      }
    });
    child.on("error", (error: Error) => {
      console.error(`[agent ${session.sessionId}] failed to start: ${error.message}`);
    });
  }

  /** Sends one human turn. The transcript records it here, not from the stream. */
  send(id: string, text: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    this.#publish(id, session, appendUserTurn(session.state, text));

    if (session.provider === "codex") {
      // One turn is in flight at a time; a second would fork the thread.
      if (session.child === null) {
        this.#spawnCodexTurn(id, session, text);
      }
      return;
    }

    if (session.child !== null && session.child.exitCode === null) {
      session.child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text }] }
        }) + "\n"
      );
    }
  }

  /**
   * Interrupts a running turn.
   *
   * SIGINT rather than closing stdin: for Claude, closing it ends the session, which is
   * `dispose`. For Codex it kills the turn and leaves the thread resumable.
   */
  interrupt(id: string): void {
    this.#sessions.get(id)?.child?.kill("SIGINT");
  }

  dispose(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    this.#sessions.delete(id);
    if (session.child !== null) {
      session.child.stdin.end();
      session.child.kill();
    }
  }

  disposeAll(): void {
    for (const id of [...this.#sessions.keys()]) {
      this.dispose(id);
    }
  }

  #consume(id: string, chunk: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    const { lines, rest } = splitLines(session.held, chunk);
    session.held = rest;

    const reduce = session.provider === "codex" ? reduceCodex : reduceSession;
    let next = session.state;
    for (const line of lines) {
      next = reduce(next, line);
    }
    // Codex only learns its thread id from the stream, and it is what `resume` needs.
    if (session.provider === "codex" && next.sessionId !== null) {
      session.threadId = next.sessionId;
    }
    // Identity is a valid "did anything change" test: the reducer returns the same
    // object for anything it ignores, so a stream of hook events costs no re-render.
    if (next !== session.state) {
      this.#publish(id, session, next);
    }
  }

  #publish(id: string, session: LiveSession, state: SessionState): void {
    session.state = state;
    this.#send(IPC.sessionEvent, { id, state });
  }
}
