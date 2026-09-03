/**
 * The contract between the main process and the renderer.
 *
 * Shared by both sides so a channel cannot be renamed on one side alone. Every channel
 * is listed here explicitly rather than assembled from strings: a typo becomes a
 * compile error instead of a silently dead listener.
 */

export const IPC = {
  /** Runtime versions, used by the shell to prove the main-preload-renderer chain. */
  runtimeInfo: "runtime:info"
} as const;

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
}
