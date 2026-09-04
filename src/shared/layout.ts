/**
 * The window's layout: tabs, each holding one or two terminal panes.
 *
 * Deliberately not a tiling tree. On a 14-inch screen with two to four agents you look
 * at one at a time and glance at the rail for the rest, so a tab list plus an optional
 * 2-up split covers the real cases without a layout engine to maintain.
 *
 * Every function here is pure and takes its id generator, so the reducers can be tested
 * without React, Electron, or a filesystem. `parseLayout` treats its input as untrusted:
 * it is JSON read back off disk, which may be truncated, hand-edited, or written by an
 * older version.
 */

export const LAYOUT_VERSION = 1;
export const MAX_PANES_PER_TAB = 2;

/** A ceiling on restored tabs. Nothing legitimate reaches it; a corrupt file might. */
export const MAX_TABS = 64;

export type IdFactory = () => string;

export interface PaneState {
  readonly id: string;
  readonly title: string;
  /** Absent for a plain shell. Set when this pane runs a coding agent. */
  readonly agent?: "claude";
  /** Absent for a terminal. Set when this pane shows something else. */
  readonly view?: "files" | "handoff";
  /** The directory a file pane is browsing, so it reopens where it was. */
  readonly path?: string;
  /**
   * Where a terminal or agent pane starts.
   *
   * Persisted, so a project tab reopens in its project rather than in the home
   * directory. A shell's real directory drifts as you `cd`; this is only where it began,
   * which is what a new pane needs to inherit.
   */
  readonly cwd?: string;
  /** The agent session this pane last ran, so it can be resumed rather than restarted. */
  readonly sessionId?: string;
  /**
   * True for an agent pane restored from disk and not yet started this run.
   *
   * Restoring must never start an agent by itself: launching burns quota the moment the
   * app opens, and an agent quietly resuming work nobody is watching is worse than one
   * that waits to be asked. A dormant pane shows what it was and waits for a click.
   */
  readonly dormant?: true;
}

export interface TabState {
  readonly id: string;
  readonly title: string;
  readonly panes: readonly PaneState[];
  readonly activePaneId: string;
}

export interface LayoutState {
  readonly version: typeof LAYOUT_VERSION;
  readonly tabs: readonly TabState[];
  readonly activeTabId: string | null;
}

export type PaneKind = "shell" | "claude" | "files" | "handoff";

function newPane(nextId: IdFactory, kind: PaneKind, cwd?: string): PaneState {
  const id = nextId();
  const where = cwd === undefined || cwd === "" ? {} : { cwd };
  if (kind === "claude") {
    return { id, title: "", agent: "claude", ...where };
  }
  // A file pane's directory is the one it browses, which is the same directory a
  // terminal beside it would start in.
  if (kind === "files" || kind === "handoff") {
    return { id, title: "", view: kind, ...(where.cwd === undefined ? {} : { path: where.cwd }) };
  }
  return { id, title: "", ...where };
}

/** The trailing directory name, which is what a person calls the project. */
function labelFor(kind: PaneKind, cwd?: string): string {
  if (kind !== "shell" || cwd === undefined || cwd === "") {
    return kind;
  }
  const leaf = cwd
    .split(/[/\\]+/)
    .filter((part) => part !== "" && !part.endsWith(":"))
    .at(-1);
  return leaf === undefined || leaf === "" ? kind : leaf;
}

function newTab(nextId: IdFactory, kind: PaneKind, cwd?: string): TabState {
  const pane = newPane(nextId, kind, cwd);
  return { id: nextId(), title: labelFor(kind, cwd), panes: [pane], activePaneId: pane.id };
}

export function defaultLayout(nextId: IdFactory, cwd?: string): LayoutState {
  const tab = newTab(nextId, "shell", cwd);
  return { version: LAYOUT_VERSION, tabs: [tab], activeTabId: tab.id };
}

/**
 * Adds a tab, inheriting a working directory when none is given.
 *
 * Inheriting from the active pane is what makes a project tab useful: open a second
 * terminal while working in a repository and it starts in that repository, rather than
 * in the home directory where nothing you are doing lives.
 */
export function createTab(
  layout: LayoutState,
  nextId: IdFactory,
  kind: PaneKind = "shell",
  cwd?: string
): LayoutState {
  const tab = newTab(nextId, kind, cwd ?? activeCwd(layout));
  return { ...layout, tabs: [...layout.tabs, tab], activeTabId: tab.id };
}

export function setActiveTab(layout: LayoutState, tabId: string): LayoutState {
  if (!layout.tabs.some((tab) => tab.id === tabId)) {
    return layout;
  }
  return { ...layout, activeTabId: tabId };
}

export function setActivePane(layout: LayoutState, tabId: string, paneId: string): LayoutState {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined || !tab.panes.some((pane) => pane.id === paneId)) {
    return layout;
  }
  return {
    ...layout,
    tabs: layout.tabs.map((candidate) =>
      candidate.id === tabId ? { ...candidate, activePaneId: paneId } : candidate
    )
  };
}

export function splitTab(layout: LayoutState, tabId: string, nextId: IdFactory): LayoutState {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined || tab.panes.length >= MAX_PANES_PER_TAB) {
    return layout;
  }
  const pane = newPane(nextId, "shell", paneCwd(tab));
  return {
    ...layout,
    tabs: layout.tabs.map((candidate) =>
      candidate.id === tabId
        ? { ...candidate, panes: [...candidate.panes, pane], activePaneId: pane.id }
        : candidate
    )
  };
}

/** Records the agent session a pane is running, so a later restore can resume it. */
export function setPaneSession(
  layout: LayoutState,
  tabId: string,
  paneId: string,
  sessionId: string
): LayoutState {
  return mapPane(layout, tabId, paneId, (pane) => ({ ...pane, sessionId }));
}

/** Remembers where a file pane is browsing. */
export function setPanePath(layout: LayoutState, tabId: string, paneId: string, path: string): LayoutState {
  return mapPane(layout, tabId, paneId, (pane) => (pane.path === path ? pane : { ...pane, path }));
}

/** Wakes a dormant pane, which is what actually starts the agent. */
export function wakePane(layout: LayoutState, tabId: string, paneId: string): LayoutState {
  return mapPane(layout, tabId, paneId, ({ dormant: _dormant, ...pane }) => pane);
}

function mapPane(
  layout: LayoutState,
  tabId: string,
  paneId: string,
  change: (pane: PaneState) => PaneState
): LayoutState {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined || !tab.panes.some((pane) => pane.id === paneId)) {
    return layout;
  }
  const pane = tab.panes.find((candidate) => candidate.id === paneId)!;
  const changed = change(pane);
  // Identity matters, not just equality. Returning a fresh object for a no-op change
  // makes every consumer re-render, which for a component that reports its own state
  // back up is an endless loop: report, re-render, report again.
  if (changed === pane) {
    return layout;
  }
  return {
    ...layout,
    tabs: layout.tabs.map((candidate) =>
      candidate.id === tabId
        ? { ...candidate, panes: candidate.panes.map((existing) => (existing.id === paneId ? changed : existing)) }
        : candidate
    )
  };
}

/** Closes one pane. Closing a tab's last pane closes the tab. */
export function unsplitPane(
  layout: LayoutState,
  tabId: string,
  paneId: string,
  nextId: IdFactory
): LayoutState {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined || !tab.panes.some((pane) => pane.id === paneId)) {
    return layout;
  }
  const remaining = tab.panes.filter((pane) => pane.id !== paneId);
  if (remaining.length === 0) {
    return closeTab(layout, tabId, nextId);
  }
  return {
    ...layout,
    tabs: layout.tabs.map((candidate) =>
      candidate.id === tabId
        ? {
            ...candidate,
            panes: remaining,
            activePaneId:
              candidate.activePaneId === paneId ? remaining[0]!.id : candidate.activePaneId
          }
        : candidate
    )
  };
}

/**
 * Closes a tab, keeping something focused.
 *
 * Closing the last tab yields a fresh one rather than an empty window: an empty state
 * here would be a screen with nothing to do on it, and every path that could produce it
 * is a path where the user still wants a shell.
 */
export function closeTab(layout: LayoutState, tabId: string, nextId: IdFactory): LayoutState {
  const index = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return layout;
  }
  const tabs = layout.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    return defaultLayout(nextId);
  }
  const activeTabId =
    layout.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)]!.id : layout.activeTabId;
  return { ...layout, tabs, activeTabId };
}

/** Where the focused pane started, if it has a directory at all. */
export function activeCwd(layout: LayoutState): string | undefined {
  const tab = layout.tabs.find((candidate) => candidate.id === layout.activeTabId);
  return tab === undefined ? undefined : paneCwd(tab);
}

function paneCwd(tab: TabState): string | undefined {
  const active = tab.panes.find((pane) => pane.id === tab.activePaneId);
  return active?.cwd ?? active?.path ?? tab.panes.find((pane) => pane.cwd !== undefined)?.cwd;
}

// --- reading untrusted stored state ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function readPane(value: unknown): PaneState | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  if (value.view === "files" || value.view === "handoff") {
    return {
      id: value.id,
      title: readString(value.title, ""),
      view: value.view,
      ...(typeof value.path === "string" && value.path !== "" ? { path: value.path } : {})
    };
  }
  const cwd = typeof value.cwd === "string" && value.cwd !== "" ? { cwd: value.cwd } : {};
  // Only a known provider survives the read; anything else becomes a plain shell.
  if (value.agent !== "claude") {
    return { id: value.id, title: readString(value.title, ""), ...cwd };
  }
  // Every restored agent pane is dormant, without exception. This is the single point
  // that guarantees opening the app never starts an agent.
  return {
    id: value.id,
    title: readString(value.title, ""),
    agent: "claude",
    dormant: true,
    ...cwd,
    ...(typeof value.sessionId === "string" && UUID.test(value.sessionId)
      ? { sessionId: value.sessionId }
      : {})
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readTab(value: unknown): TabState | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") {
    return null;
  }
  const panes = Array.isArray(value.panes)
    ? value.panes.map(readPane).filter((pane): pane is PaneState => pane !== null).slice(0, MAX_PANES_PER_TAB)
    : [];
  if (panes.length === 0) {
    return null;
  }
  // A stored activePaneId can name a pane that no longer exists — the file may predate a
  // change, or have been edited. Repaired to a real pane rather than left dangling,
  // which would render a tab with nothing focused.
  const activePaneId = panes.some((pane) => pane.id === value.activePaneId)
    ? (value.activePaneId as string)
    : panes[0]!.id;
  return { id: value.id, title: readString(value.title, "shell"), panes, activePaneId };
}

/**
 * Reads stored layout state, falling back to a usable default.
 *
 * Never throws and never returns an unusable layout: a corrupt or truncated file must
 * cost the user their tab arrangement, not their ability to open the app.
 */
export function parseLayout(value: unknown, nextId: IdFactory = defaultIdFactory): LayoutState {
  if (!isRecord(value) || value.version !== LAYOUT_VERSION || !Array.isArray(value.tabs)) {
    return defaultLayout(nextId);
  }

  const seen = new Set<string>();
  const tabs: TabState[] = [];
  for (const candidate of value.tabs) {
    const tab = readTab(candidate);
    // Duplicate ids would make selection ambiguous — two tabs would answer to one click.
    if (tab === null || seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    tabs.push(tab);
    if (tabs.length >= MAX_TABS) {
      break;
    }
  }

  if (tabs.length === 0) {
    return defaultLayout(nextId);
  }

  const activeTabId = tabs.some((tab) => tab.id === value.activeTabId)
    ? (value.activeTabId as string)
    : tabs[0]!.id;

  return { version: LAYOUT_VERSION, tabs, activeTabId };
}

/**
 * Used only when `parseLayout` has to build a fallback and the caller supplied no
 * factory. `crypto.randomUUID` is available in both the main process and the renderer.
 */
const defaultIdFactory: IdFactory = () => crypto.randomUUID();
