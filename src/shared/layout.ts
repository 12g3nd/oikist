/**
 * The window's layout: tabs, each holding a tree of panes.
 *
 * It was deliberately *not* a tiling tree until 2026-09-06, on the argument that a
 * 14-inch screen has no room for six panes. Day 2 of real use disagreed in the first
 * finding it produced, and section 5 of the decision record carries the reversal: the
 * size argument was answering a question nobody had, and a pane you cannot rearrange is
 * a pane you cannot get out of the way.
 *
 * Every function here is pure and takes its id generator, so the reducers can be tested
 * without React, Electron, or a filesystem. `parseLayout` treats its input as untrusted:
 * it is JSON read back off disk, which may be truncated, hand-edited, or written by an
 * older version.
 */

export const LAYOUT_VERSION = 1;
/**
 * Raised from 2 to 8 when tiling landed.
 *
 * The cap was never really about screen size — that argument was wrong, and section 5 of
 * the decision record says why. It exists so a corrupt file cannot produce a thousand
 * panes.
 */
export const MAX_PANES_PER_TAB = 8;

/** How far a divider can be dragged before a pane would vanish. */
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

/** A ceiling on restored tabs. Nothing legitimate reaches it; a corrupt file might. */
export const MAX_TABS = 64;

export type IdFactory = () => string;

export interface PaneState {
  readonly id: string;
  readonly title: string;
  /** Absent for a plain shell. Set when this pane runs a coding agent. */
  readonly agent?: "claude" | "codex";
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

/**
 * How the panes of a tab are arranged on screen.
 *
 * A tree of pane *ids*, held beside the flat pane list rather than replacing it. Keeping
 * the panes flat means every existing reducer still works, a layout stored before tiling
 * needs no migration, and — the load-bearing one — `parseLayout` can repair a broken
 * arrangement against the pane list. A corrupt tree then costs the arrangement and never
 * the panes. See `docs/PHASE-3-tiling.md`.
 */
export type Arrangement =
  | { readonly kind: "leaf"; readonly paneId: string }
  | {
      readonly kind: "split";
      readonly direction: "row" | "column";
      readonly ratio: number;
      readonly children: readonly [Arrangement, Arrangement];
    };

/** A path to a node: which child to take at each split, from the root. */
export type ArrangementPath = readonly (0 | 1)[];

export interface TabState {
  readonly id: string;
  readonly title: string;
  readonly panes: readonly PaneState[];
  readonly activePaneId: string;
  readonly arrangement: Arrangement;
  /** Temporarily showing one pane full-tab. Hides the others; does not rearrange them. */
  readonly maximizedPaneId?: string;
}

export interface LayoutState {
  readonly version: typeof LAYOUT_VERSION;
  readonly tabs: readonly TabState[];
  readonly activeTabId: string | null;
}

export type PaneKind = "shell" | "claude" | "codex" | "files" | "handoff";

function clampRatio(value: unknown): number {
  const ratio = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** Every pane id the tree mentions, in visual order. */
export function arrangementPanes(node: Arrangement): string[] {
  return node.kind === "leaf"
    ? [node.paneId]
    : [...arrangementPanes(node.children[0]), ...arrangementPanes(node.children[1])];
}

/** Builds a left-leaning arrangement for a flat list — the shape old layouts imply. */
export function arrangementFor(paneIds: readonly string[]): Arrangement {
  const [first, ...rest] = paneIds;
  let node: Arrangement = { kind: "leaf", paneId: first ?? "" };
  for (const paneId of rest) {
    node = { kind: "split", direction: "row", ratio: 0.5, children: [node, { kind: "leaf", paneId }] };
  }
  return node;
}

/**
 * Replaces one leaf, leaving every other node identical.
 *
 * Identity in, identity out: an untouched subtree must not be rebuilt, or React
 * reconciles a pane that never moved and remounts a running agent.
 */
function replaceLeaf(node: Arrangement, paneId: string, made: (leaf: Arrangement) => Arrangement): Arrangement {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? made(node) : node;
  }
  const left = replaceLeaf(node.children[0], paneId, made);
  const right = replaceLeaf(node.children[1], paneId, made);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

/** Removes a leaf and collapses the split that held it onto the surviving sibling. */
function removeLeaf(node: Arrangement, paneId: string): Arrangement | null {
  if (node.kind === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const left = removeLeaf(node.children[0], paneId);
  const right = removeLeaf(node.children[1], paneId);
  if (left === null) return right;
  if (right === null) return left;
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

function nodeAt(node: Arrangement, path: ArrangementPath): Arrangement | null {
  let current: Arrangement = node;
  for (const step of path) {
    if (current.kind !== "split") return null;
    current = current.children[step];
  }
  return current;
}

function mapAt(node: Arrangement, path: ArrangementPath, change: (found: Arrangement) => Arrangement): Arrangement {
  if (path.length === 0) return change(node);
  if (node.kind !== "split") return node;
  const index = path[0] ?? 0;
  const updated = mapAt(node.children[index], path.slice(1), change);
  if (updated === node.children[index]) return node;
  const children: [Arrangement, Arrangement] =
    index === 0 ? [updated, node.children[1]] : [node.children[0], updated];
  return { ...node, children };
}

function withTab(layout: LayoutState, tabId: string, change: (tab: TabState) => TabState): LayoutState {
  const tab = layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return layout;
  const next = change(tab);
  if (next === tab) return layout;
  return { ...layout, tabs: layout.tabs.map((candidate) => (candidate.id === tabId ? next : candidate)) };
}

/** Splits a pane, putting a new shell beside it in the given direction. */
export function splitPane(
  layout: LayoutState,
  tabId: string,
  paneId: string,
  direction: "row" | "column",
  nextId: IdFactory
): LayoutState {
  return withTab(layout, tabId, (tab) => {
    if (tab.panes.length >= MAX_PANES_PER_TAB || !tab.panes.some((pane) => pane.id === paneId)) {
      return tab;
    }
    const pane = newPane(nextId, "shell", paneCwd(tab));
    const arrangement = replaceLeaf(tab.arrangement, paneId, (leaf) => ({
      kind: "split",
      direction,
      ratio: 0.5,
      children: [leaf, { kind: "leaf", paneId: pane.id }]
    }));
    return { ...tab, panes: [...tab.panes, pane], arrangement, activePaneId: pane.id };
  });
}

/** Closes one pane. The last pane of a tab is replaced rather than removed. */
export function closePane(
  layout: LayoutState,
  tabId: string,
  paneId: string,
  nextId: IdFactory
): LayoutState {
  return withTab(layout, tabId, (tab) => {
    if (!tab.panes.some((pane) => pane.id === paneId)) return tab;
    const panes = tab.panes.filter((pane) => pane.id !== paneId);
    if (panes.length === 0) {
      const pane = newPane(nextId, "shell", paneCwd(tab));
      return {
        ...tab,
        panes: [pane],
        arrangement: { kind: "leaf", paneId: pane.id },
        activePaneId: pane.id
      };
    }
    const arrangement = removeLeaf(tab.arrangement, paneId) ?? arrangementFor(panes.map((pane) => pane.id));
    const keepMaximized = tab.maximizedPaneId !== undefined && tab.maximizedPaneId !== paneId;
    const base: TabState = {
      id: tab.id,
      title: tab.title,
      panes,
      arrangement,
      activePaneId: tab.activePaneId === paneId ? (panes[0]?.id ?? tab.activePaneId) : tab.activePaneId
    };
    // Nothing may stay maximised once it is gone.
    return keepMaximized && tab.maximizedPaneId !== undefined
      ? { ...base, maximizedPaneId: tab.maximizedPaneId }
      : base;
  });
}

/** Moves one divider. `path` addresses the split, from the root. */
export function setRatio(
  layout: LayoutState,
  tabId: string,
  path: ArrangementPath,
  ratio: number
): LayoutState {
  return withTab(layout, tabId, (tab) => {
    const target = nodeAt(tab.arrangement, path);
    if (target === null || target.kind !== "split") return tab;
    const clamped = clampRatio(ratio);
    if (clamped === target.ratio) return tab;
    return {
      ...tab,
      arrangement: mapAt(tab.arrangement, path, (node) =>
        node.kind === "split" ? { ...node, ratio: clamped } : node
      )
    };
  });
}

/**
 * Shows one pane full-tab, or restores the arrangement.
 *
 * Temporary by design: it hides the others rather than rearranging them, so restoring is
 * exact rather than reconstructed.
 */
export function toggleMaximized(layout: LayoutState, tabId: string, paneId: string): LayoutState {
  return withTab(layout, tabId, (tab) => {
    if (!tab.panes.some((pane) => pane.id === paneId)) return tab;
    if (tab.maximizedPaneId === paneId) {
      return {
        id: tab.id,
        title: tab.title,
        panes: tab.panes,
        arrangement: tab.arrangement,
        activePaneId: tab.activePaneId
      };
    }
    return { ...tab, maximizedPaneId: paneId, activePaneId: paneId };
  });
}


function newPane(nextId: IdFactory, kind: PaneKind, cwd?: string): PaneState {
  const id = nextId();
  const where = cwd === undefined || cwd === "" ? {} : { cwd };
  if (kind === "claude" || kind === "codex") {
    return { id, title: "", agent: kind, ...where };
  }
  // A file pane's directory is the one it browses, which is the same directory a
  // terminal beside it would start in.
  if (kind === "files" || kind === "handoff") {
    return { id, title: "", view: kind, ...(where.cwd === undefined ? {} : { path: where.cwd }) };
  }
  return { id, title: "", ...where };
}

/**
 * A tab's name: the project it is in, and the provider when it runs an agent.
 *
 * The project leads because a tab truncates from the end. With three agents open, three
 * tabs reading `claude` say nothing at all — the project is the half worth keeping when
 * there is only room for one.
 */
function labelFor(kind: PaneKind, cwd?: string): string {
  if (cwd === undefined || cwd === "") {
    return kind;
  }
  const leaf = cwd
    .split(/[/\\]+/)
    .filter((part) => part !== "" && !part.endsWith(":"))
    .at(-1);
  if (leaf === undefined || leaf === "") {
    return kind;
  }
  // A shell is the ordinary case and needs no qualifier; everything else says what it is
  // after the project, since a bare `files` in a two-project day names nothing.
  return kind === "shell" ? leaf : `${leaf} · ${kind}`;
}

function newTab(nextId: IdFactory, kind: PaneKind, cwd?: string): TabState {
  const pane = newPane(nextId, kind, cwd);
  return {
    id: nextId(),
    title: labelFor(kind, cwd),
    panes: [pane],
    activePaneId: pane.id,
    arrangement: { kind: "leaf", paneId: pane.id }
  };
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
  // Kept as the plain "split the active pane to the right" verb the tab bar and
  // Ctrl+Shift+E already use. Everything else goes through splitPane.
  return splitPane(layout, tabId, tab.activePaneId, "row", nextId);
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
  if (value.agent !== "claude" && value.agent !== "codex") {
    return { id: value.id, title: readString(value.title, ""), ...cwd };
  }
  // Every restored agent pane is dormant, without exception. This is the single point
  // that guarantees opening the app never starts an agent.
  return {
    id: value.id,
    title: readString(value.title, ""),
    agent: value.agent,
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
  // A title that is still just the kind was written before titles named their project.
  // Re-derived rather than left as-is, so the tabs already on screen are fixed too and
  // not only the ones opened afterwards. Titles are machine-generated — there is no
  // rename — so nothing a person chose can be overwritten here.
  const stored = readString(value.title, "shell");
  const active = panes.find((pane) => pane.id === activePaneId) ?? panes[0]!;
  const title = isBareKind(stored) ? labelFor(stored, active.cwd ?? active.path) : stored;
  const arrangement = repairArrangement(value.arrangement, panes.map((pane) => pane.id));
  const maximized = value.maximizedPaneId;
  // A maximise naming a pane that is gone would hide every remaining pane behind
  // nothing at all — the tab would open blank.
  const keepMaximized =
    typeof maximized === "string" && panes.some((pane) => pane.id === maximized);
  return {
    id: value.id,
    title,
    panes,
    activePaneId,
    arrangement,
    ...(keepMaximized ? { maximizedPaneId: maximized as string } : {})
  };
}

/**
 * Makes a stored arrangement agree with the panes that actually exist.
 *
 * Two structures have to agree and only one of them holds content, so the rule is that
 * the pane list wins: leaves naming a pane that is gone are pruned, and panes the tree
 * forgot are appended rather than orphaned. A layout written before tiling has no
 * arrangement at all and is simply given one.
 *
 * This is the reason the tree holds ids rather than panes. A tree holding the panes
 * themselves has no fallback, because losing the tree would lose the content.
 */
function repairArrangement(value: unknown, paneIds: readonly string[]): Arrangement {
  const pruned = readArrangement(value, new Set(paneIds));
  const seen = pruned === null ? [] : arrangementPanes(pruned);
  const missing = paneIds.filter((id) => !seen.includes(id));
  if (pruned === null) {
    return arrangementFor(paneIds);
  }
  return missing.reduce<Arrangement>(
    (node, paneId) => ({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      children: [node, { kind: "leaf", paneId }]
    }),
    pruned
  );
}

/** Reads an untrusted node, dropping anything that does not name a live pane. */
function readArrangement(value: unknown, live: ReadonlySet<string>): Arrangement | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") {
    return typeof node.paneId === "string" && live.has(node.paneId)
      ? { kind: "leaf", paneId: node.paneId }
      : null;
  }
  if (node.kind !== "split" || !Array.isArray(node.children)) {
    return null;
  }
  const left = readArrangement(node.children[0], live);
  const right = readArrangement(node.children[1], live);
  if (left === null) return right;
  if (right === null) return left;
  return {
    kind: "split",
    direction: node.direction === "column" ? "column" : "row",
    ratio: clampRatio(node.ratio),
    children: [left, right]
  };
}

function isBareKind(title: string): title is PaneKind {
  return (
    title === "shell" ||
    title === "claude" ||
    title === "codex" ||
    title === "files" ||
    title === "handoff"
  );
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
