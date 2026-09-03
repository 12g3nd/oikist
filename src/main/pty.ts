import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type { WebContents } from "electron";
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";

import { IPC, type PtyCreateOptions } from "../shared/ipc.js";

/**
 * How long pty output is accumulated before one IPC message is sent.
 *
 * A build pouring output through a pty fires `onData` far faster than a frame, and
 * forwarding each read individually would cross the process boundary thousands of times
 * a second and repaint the terminal just as often. Coalescing into roughly one frame
 * costs an imperceptible amount of latency and is the difference between a terminal
 * that keeps up with `npm run build` and one that does not.
 */
const FLUSH_MS = 8;

/**
 * A hard ceiling on how much unflushed output one pty may buffer.
 *
 * A process emitting faster than the renderer can accept must not grow the buffer
 * without limit. Past this the oldest bytes are dropped, which is what a terminal
 * scrollback would do anyway, rather than letting the main process exhaust memory.
 */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

interface Session {
  readonly pty: IPty;
  pending: string;
  timer: NodeJS.Timeout | null;
}

type SpawnFn = (file: string, args: string[], options: IPtyForkOptions & IWindowsPtyForkOptions) => IPty;

/**
 * node-pty is loaded on first use, not at module load.
 *
 * Importing it statically pulls in a native addon during startup even when no terminal
 * is ever opened, which costs startup time for nothing. It is cached after the first
 * terminal so the cost is paid once.
 */
let spawnPty: SpawnFn | null = null;
async function loadSpawn(): Promise<SpawnFn> {
  if (spawnPty === null) {
    const module = await import("node-pty");
    spawnPty = module.spawn as SpawnFn;
  }
  return spawnPty;
}

/** The shell a new terminal starts. Windows-only, matching the project's scope. */
function defaultShell(): string {
  return process.env.COMSPEC ?? "cmd.exe";
}

export class PtyManager {
  readonly #sessions = new Map<string, Session>();
  readonly #send: (channel: string, payload: unknown) => void;

  /**
   * `send` is injected rather than a WebContents captured directly, so the manager can
   * be exercised without an Electron window.
   */
  constructor(send: (channel: string, payload: unknown) => void) {
    this.#send = send;
  }

  static forWebContents(contents: WebContents): PtyManager {
    return new PtyManager((channel, payload) => {
      // A destroyed WebContents throws on send; a pty outliving its window by a few
      // milliseconds during shutdown is normal and must not crash the main process.
      if (!contents.isDestroyed()) {
        contents.send(channel, payload);
      }
    });
  }

  async create(options: PtyCreateOptions): Promise<string> {
    const id = randomUUID();
    const spawn = await loadSpawn();
    const pty = spawn(defaultShell(), [], {
      name: "xterm-256color",
      cols: Math.max(1, Math.trunc(options.cols)),
      rows: Math.max(1, Math.trunc(options.rows)),
      cwd: options.cwd ?? homedir(),
      env: process.env as Record<string, string>,
      // Uses node-pty's bundled conpty.dll instead of the OS ConPTY.
      //
      // Not a preference. On the default path, killing a pty forks
      // `conpty_console_list_agent` to enumerate the shell's child processes so it can
      // kill them too. That fork fails here with "AttachConsole failed", so the promise
      // never resolves and the children are never killed — closing a pane running
      // `npm run dev` would orphan the dev server. node-pty's own source flags exactly
      // this hazard (Microsoft/vscode#26807). The DLL path skips that fork entirely.
      useConptyDll: true
    });

    const session: Session = { pty, pending: "", timer: null };
    this.#sessions.set(id, session);

    pty.onData((chunk) => {
      session.pending += chunk;
      if (session.pending.length > MAX_PENDING_BYTES) {
        session.pending = session.pending.slice(-MAX_PENDING_BYTES);
      }
      if (session.timer === null) {
        session.timer = setTimeout(() => this.#flush(id), FLUSH_MS);
      }
    });

    pty.onExit(({ exitCode }) => {
      // Flushed before the exit notice so the last output of a command is never lost to
      // the process ending inside a pending batch.
      this.#flush(id);
      this.#sessions.delete(id);
      this.#send(IPC.ptyExit, { id, exitCode });
    });

    return id;
  }

  write(id: string, data: string): void {
    this.#sessions.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    try {
      session.pty.resize(Math.max(1, Math.trunc(cols)), Math.max(1, Math.trunc(rows)));
    } catch {
      // A resize racing the process exiting is not an error worth surfacing.
    }
  }

  dispose(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    if (session.timer !== null) {
      clearTimeout(session.timer);
    }
    this.#sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }

  /** Kills every session. Called when the window closes so no shell is orphaned. */
  disposeAll(): void {
    for (const id of [...this.#sessions.keys()]) {
      this.dispose(id);
    }
  }

  #flush(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined) {
      return;
    }
    if (session.timer !== null) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.pending === "") {
      return;
    }
    const chunk = session.pending;
    session.pending = "";
    this.#send(IPC.ptyData, { id, chunk });
  }
}
