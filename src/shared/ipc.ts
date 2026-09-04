import type { AgentSummary } from "./agents.js";
import type { FileContent, FileEntry } from "./files.js";
import type { WorkingState } from "./handoff.js";
import type { ProviderLimits } from "./limits.js";

/**
 * The contract between the main process and the renderer.
 *
 * Shared by both sides so a channel cannot be renamed on one side alone. Every channel
 * is listed here explicitly rather than assembled from strings: a typo becomes a
 * compile error instead of a silently dead listener.
 */

export const IPC = {
  /** Runtime versions, used by the shell to prove the main-preload-renderer chain. */
  runtimeInfo: "runtime:info",

  ptyCreate: "pty:create",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyDispose: "pty:dispose",
  /** Main to renderer. Batched, so one message carries many pty reads. */
  ptyData: "pty:data",
  /** Main to renderer, once per pty. */
  ptyExit: "pty:exit",

  layoutLoad: "layout:load",
  layoutSave: "layout:save",

  filesList: "files:list",
  filesRead: "files:read",
  filesHome: "files:home",

  handoffState: "handoff:state",
  handoffCopy: "handoff:copy",
  providerLimits: "provider:limits",

  agentsList: "agents:list",
  /** Main to renderer, once per discovery pass. */
  agentsUpdated: "agents:updated"
} as const;

export interface PtyCreateOptions {
  readonly cwd?: string;
  readonly cols: number;
  readonly rows: number;
  /** Absent for a plain shell; set to run a coding agent in this pane instead. */
  readonly agent?: "claude";
  /** Resume this agent session instead of starting a new one. */
  readonly resumeSessionId?: string;
}

export interface PtyCreated {
  readonly id: string;
  /** Present for an agent pane: the session the rail will show. */
  readonly agentSessionId?: string;
}

export interface PtyDataMessage {
  readonly id: string;
  readonly chunk: string;
}

export interface PtyExitMessage {
  readonly id: string;
  readonly exitCode: number;
}

export interface PtyBridge {
  readonly create: (options: PtyCreateOptions) => Promise<PtyCreated>;
  readonly write: (id: string, data: string) => void;
  readonly resize: (id: string, cols: number, rows: number) => void;
  readonly dispose: (id: string) => void;
  /** Returns an unsubscribe function, so a React effect can clean up after itself. */
  readonly onData: (listener: (message: PtyDataMessage) => void) => () => void;
  readonly onExit: (listener: (message: PtyExitMessage) => void) => () => void;
}

export interface RuntimeInfo {
  readonly app: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: NodeJS.Platform;
}

/** What `window.oikist` exposes. The preload bridge and the renderer both implement it. */
export interface OikistBridge {
  readonly runtimeInfo: () => Promise<RuntimeInfo>;
  readonly pty: PtyBridge;
  readonly layout: {
    /** Raw stored value. The renderer validates it with `parseLayout`. */
    readonly load: () => Promise<unknown>;
    readonly save: (layout: unknown) => void;
  };
  readonly files: {
    readonly home: () => Promise<string>;
    readonly list: (path: string) => Promise<DirectoryListing>;
    readonly read: (path: string) => Promise<FileContent>;
  };
  readonly handoff: {
    /** Reads the git working state a handoff carries. */
    readonly state: (cwd: string) => Promise<WorkingState>;
    /** Puts the composed block on the clipboard. */
    readonly copy: (text: string) => Promise<void>;
    readonly limits: () => Promise<readonly ProviderLimits[]>;
  };
  readonly agents: {
    readonly list: () => Promise<AgentsSnapshot>;
    readonly onUpdate: (listener: (snapshot: AgentsSnapshot) => void) => () => void;
  };
}

export interface AgentsSnapshot {
  readonly agents: readonly AgentSummary[];
  /** False when the provider could not be consulted — not the same as "no agents". */
  readonly ok: boolean;
  readonly error?: string;
  readonly refreshedAt: string;
}

export interface DirectoryListing {
  readonly path: string;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
}
