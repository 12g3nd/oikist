import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import {
  appendUserTurn,
  emptySession,
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

/** Claude is resolved to an absolute `.exe` by the caller; see `AgentLauncher`. */
export interface AgentSessionRequest {
  readonly file: string;
  readonly cwd?: string;
  readonly sessionId: string;
  readonly resumeSessionId?: string;
}

interface LiveSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly sessionId: string;
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

  /** The arguments that turn the CLI into a stream-json conversation. */
  static argsFor(request: AgentSessionRequest): string[] {
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose"
    ];
    if (request.resumeSessionId === undefined) {
      args.push("--session-id", request.sessionId);
    } else {
      args.push("--resume", request.resumeSessionId);
    }
    return args;
  }

  start(request: AgentSessionRequest): string {
    const id = randomUUID();
    const child = spawn(request.file, AgentSessionManager.argsFor(request), {
      cwd: request.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const session: LiveSession = {
      child,
      sessionId: request.sessionId,
      held: "",
      state: emptySession()
    };
    this.#sessions.set(id, session);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(id, chunk));

    // stderr is the CLI's own diagnostics, never conversation. It goes to the main
    // process log so a session that fails to start says why, rather than presenting as
    // a pane that does nothing.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text !== "") {
        console.error(`[agent ${request.sessionId}] ${text}`);
      }
    });

    // An agent whose process ends is no longer running, and the pane must stop saying
    // it is. A crashed agent sends no closing event, so the exit is the only signal.
    child.on("exit", (code) => {
      this.#sessions.delete(id);
      this.#send(IPC.sessionExit, { id, exitCode: code ?? 0 });
    });
    child.on("error", (error: Error) => {
      console.error(`[agent ${request.sessionId}] failed to start: ${error.message}`);
    });

    return id;
  }

  /** Sends one human turn. The transcript records it here, not from the stream. */
  send(id: string, text: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined || session.child.exitCode !== null) {
      return;
    }
    this.#publish(id, session, appendUserTurn(session.state, text));
    session.child.stdin.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] }
      }) + "\n"
    );
  }

  /**
   * Interrupts a running turn.
   *
   * SIGINT rather than closing stdin: closing it ends the session, which is `dispose`.
   */
  interrupt(id: string): void {
    this.#sessions.get(id)?.child.kill("SIGINT");
  }

  dispose(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    this.#sessions.delete(id);
    session.child.stdin.end();
    session.child.kill();
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

    let next = session.state;
    for (const line of lines) {
      next = reduceSession(next, line);
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
