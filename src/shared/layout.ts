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

function newPane(nextId: IdFactory, agent?: "claude"): PaneState {
  return agent === undefined ? { id: nextId(), title: "" } : { id: nextId(), title: "", agent };
}

function newTab(nextId: IdFactory, agent?: "claude"): TabState {
  const pane = newPane(nextId, agent);
  return { id: nextId(), title: agent ?? "shell", panes: [pane], activePaneId: pane.id };
}

export function defaultLayout(nextId: IdFactory): LayoutState {
  const tab = newTab(nextId);
  return { version: LAYOUT_VERSION, tabs: [tab], activeTabId: tab.id };
}

export function createTab(layout: LayoutState, nextId: IdFactory, agent?: "claude"): LayoutState {
  const tab = newTab(nextId, agent);
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
  const pane = newPane(nextId);
  return {
    ...layout,
    tabs: layout.tabs.map((candidate) =>
      candidate.id === tabId
        ? { ...candidate, panes: [...candidate.panes, pane], activePaneId: pane.id }
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
  // Only a known provider survives the read; anything else becomes a plain shell.
  return value.agent === "claude"
    ? { id: value.id, title: readString(value.title, ""), agent: "claude" }
    : { id: value.id, title: readString(value.title, "") };
}

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
