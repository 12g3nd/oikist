import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PANES_PER_TAB,
  closeTab,
  createTab,
  defaultLayout,
  parseLayout,
  closePane,
  layoutRects,
  setActivePane,
  setRatio,
  splitPane,
  toggleMaximized,
  setActiveTab,
  activeCwd,
  splitTab,
  setPaneSession,
  unsplitPane,
  wakePane
} from "../src/shared/layout.js";

/** Deterministic ids so assertions read plainly. */
function ids(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

test("a fresh layout has exactly one tab with one pane, and it is active", () => {
  const layout = defaultLayout(ids("x"));
  assert.equal(layout.tabs.length, 1);
  assert.equal(layout.tabs[0]?.panes.length, 1);
  assert.equal(layout.activeTabId, layout.tabs[0]?.id);
  assert.equal(layout.tabs[0]?.activePaneId, layout.tabs[0]?.panes[0]?.id);
});

test("a new tab is appended and becomes active", () => {
  const next = ids("t");
  const layout = createTab(defaultLayout(next), next);
  assert.equal(layout.tabs.length, 2);
  assert.equal(layout.activeTabId, layout.tabs[1]?.id, "the new tab takes focus");
});

/*
 * The 2-up cap was reversed on 2026-09-06 with section 5. What is still tested is that a
 * cap exists at all: it is what stops a corrupt file producing a thousand panes.
 */
test("splitting adds a pane and focuses it; the cap still holds", () => {
  const next = ids("p");
  const start = defaultLayout(next);
  const split = splitTab(start, start.activeTabId!, next);

  assert.equal(split.tabs[0]?.panes.length, 2);
  assert.equal(split.tabs[0]?.activePaneId, split.tabs[0]?.panes[1]?.id, "the new pane takes focus");

  let layout = split;
  for (let n = 0; n < MAX_PANES_PER_TAB + 3; n += 1) {
    layout = splitTab(layout, layout.activeTabId!, next);
  }
  assert.equal(layout.tabs[0]?.panes.length, MAX_PANES_PER_TAB, "the cap is never exceeded");
  // Identity, not equality: a reducer that rebuilds state for an unchanged value makes a
  // component reporting upward loop forever.
  assert.equal(splitTab(layout, layout.activeTabId!, next), layout, "a no-op returns the same object");
});

test("closing one pane of a split leaves the other focused", () => {
  const next = ids("p");
  const start = defaultLayout(next);
  const split = splitTab(start, start.activeTabId!, next);
  const first = split.tabs[0]!.panes[0]!.id;
  const second = split.tabs[0]!.panes[1]!.id;

  const closed = unsplitPane(split, split.activeTabId!, second, next);
  assert.equal(closed.tabs[0]?.panes.length, 1);
  assert.equal(closed.tabs[0]?.panes[0]?.id, first);
  assert.equal(closed.tabs[0]?.activePaneId, first, "focus moves to the surviving pane");
});

test("closing the only pane of a tab closes the tab", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  layout = createTab(layout, next);
  const doomed = layout.activeTabId!;

  const closed = unsplitPane(layout, doomed, layout.tabs[1]!.panes[0]!.id, next);
  assert.equal(closed.tabs.length, 1);
  assert.equal(closed.tabs.some((tab) => tab.id === doomed), false);
});

test("closing a tab activates a neighbour rather than leaving nothing focused", () => {
  const next = ids("t");
  let layout = defaultLayout(next);
  layout = createTab(layout, next);
  layout = createTab(layout, next);
  const middle = layout.tabs[1]!.id;

  const closed = closeTab(layout, middle, next);
  assert.equal(closed.tabs.length, 2);
  assert.ok(closed.tabs.some((tab) => tab.id === closed.activeTabId), "the active tab still exists");
});

test("closing the last tab yields a fresh one rather than an empty window", () => {
  const next = ids("t");
  const layout = defaultLayout(next);
  const closed = closeTab(layout, layout.activeTabId!, next);

  assert.equal(closed.tabs.length, 1, "always at least one tab");
  assert.notEqual(closed.tabs[0]?.id, layout.tabs[0]?.id, "and it is a new one");
  assert.equal(closed.activeTabId, closed.tabs[0]?.id);
});

test("activating an unknown tab or pane leaves the layout untouched", () => {
  const next = ids("t");
  const layout = createTab(defaultLayout(next), next);
  assert.deepEqual(setActiveTab(layout, "nope"), layout);
  assert.deepEqual(setActivePane(layout, layout.activeTabId!, "nope"), layout);
  assert.deepEqual(setActivePane(layout, "nope", layout.tabs[0]!.panes[0]!.id), layout);
});

test("activating a real tab and pane moves focus", () => {
  const next = ids("t");
  const layout = createTab(defaultLayout(next), next);
  const first = layout.tabs[0]!.id;
  assert.equal(setActiveTab(layout, first).activeTabId, first);
});

// --- parseLayout: everything below is untrusted content read back off disk ---

test("a round trip through JSON survives exactly", () => {
  const next = ids("r");
  const layout = splitTab(createTab(defaultLayout(next), next), "r1", next);
  assert.deepEqual(parseLayout(JSON.parse(JSON.stringify(layout))), layout);
});

test("garbage falls back to a usable default instead of throwing", () => {
  for (const value of [null, undefined, 42, "layout", [], {}, { version: 99 }, { version: 1 }]) {
    const parsed = parseLayout(value);
    assert.ok(parsed.tabs.length >= 1, `${JSON.stringify(value)} must still yield a usable layout`);
    assert.ok(parsed.tabs.some((tab) => tab.id === parsed.activeTabId));
  }
});

test("a tab with no panes, or too many, is rejected rather than rendered", () => {
  const base = defaultLayout(ids("z"));
  const noPanes = { ...base, tabs: [{ id: "a", title: "t", panes: [], activePaneId: "x" }] };
  const tooMany = {
    ...base,
    tabs: [{
      id: "a",
      title: "t",
      activePaneId: "p1",
      panes: [{ id: "p1", title: "" }, { id: "p2", title: "" }, { id: "p3", title: "" }]
    }]
  };
  assert.ok(parseLayout(noPanes).tabs[0]!.panes.length >= 1);
  assert.ok(parseLayout(tooMany).tabs[0]!.panes.length <= MAX_PANES_PER_TAB);
});

test("an activePaneId that names no pane is repaired to a real one", () => {
  const stored = {
    version: 1,
    activeTabId: "a",
    tabs: [{ id: "a", title: "one", activePaneId: "ghost", panes: [{ id: "p1", title: "" }] }]
  };
  const parsed = parseLayout(stored);
  assert.equal(parsed.tabs[0]?.activePaneId, "p1");
});

test("an activeTabId that names no tab is repaired to a real one", () => {
  const stored = {
    version: 1,
    activeTabId: "ghost",
    tabs: [{ id: "a", title: "one", activePaneId: "p1", panes: [{ id: "p1", title: "" }] }]
  };
  assert.equal(parseLayout(stored).activeTabId, "a");
});

test("duplicate tab ids are dropped, since two panes cannot share an identity", () => {
  const stored = {
    version: 1,
    activeTabId: "a",
    tabs: [
      { id: "a", title: "one", activePaneId: "p1", panes: [{ id: "p1", title: "" }] },
      { id: "a", title: "two", activePaneId: "p2", panes: [{ id: "p2", title: "" }] }
    ]
  };
  assert.equal(parseLayout(stored).tabs.length, 1);
});

test("an absurd number of stored tabs is capped", () => {
  const tabs = Array.from({ length: 500 }, (_, i) => ({
    id: `t${i}`,
    title: `tab ${i}`,
    activePaneId: `p${i}`,
    panes: [{ id: `p${i}`, title: "" }]
  }));
  const parsed = parseLayout({ version: 1, activeTabId: "t0", tabs });
  assert.ok(parsed.tabs.length <= 64, `expected a cap, got ${parsed.tabs.length}`);
});

// --- restore must never start an agent by itself ---

const AGENT_SESSION = "310ff72c-7a29-4972-acc8-edb59ebee744";

function storedAgentLayout(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    activeTabId: "t",
    tabs: [
      {
        id: "t",
        title: "claude",
        activePaneId: "p",
        panes: [{ id: "p", title: "", agent: "claude", ...extra }]
      }
    ]
  };
}

test("every restored agent pane is dormant, so opening the app starts nothing", () => {
  const parsed = parseLayout(storedAgentLayout({ sessionId: AGENT_SESSION }));
  const pane = parsed.tabs[0]!.panes[0]!;
  assert.equal(pane.agent, "claude");
  assert.equal(pane.dormant, true, "a restored agent must wait to be asked");
  assert.equal(pane.sessionId, AGENT_SESSION, "so it can be resumed rather than restarted");
});

test("a dormant pane is marked dormant even when the file says otherwise", () => {
  // The flag is not read back from disk: it is imposed. Nothing a stored file contains
  // may cause a launch on startup.
  const parsed = parseLayout(storedAgentLayout({ dormant: false }));
  assert.equal(parsed.tabs[0]!.panes[0]!.dormant, true);
});

test("a stored sessionId that is not a canonical uuid is dropped", () => {
  const parsed = parseLayout(storedAgentLayout({ sessionId: "../../etc/passwd" }));
  assert.equal(parsed.tabs[0]!.panes[0]!.sessionId, undefined);
});

test("a shell pane is never dormant, because a shell costs nothing to start", () => {
  const parsed = parseLayout({
    version: 1,
    activeTabId: "t",
    tabs: [{ id: "t", title: "shell", activePaneId: "p", panes: [{ id: "p", title: "" }] }]
  });
  assert.equal(parsed.tabs[0]!.panes[0]!.dormant, undefined);
});

test("waking a pane clears dormant and nothing else", () => {
  const parsed = parseLayout(storedAgentLayout({ sessionId: AGENT_SESSION }));
  const woken = wakePane(parsed, "t", "p");
  const pane = woken.tabs[0]!.panes[0]!;
  assert.equal(pane.dormant, undefined);
  assert.equal(pane.sessionId, AGENT_SESSION, "the session survives so it can be resumed");
  assert.equal(pane.agent, "claude");
});

test("recording a session id leaves the rest of the layout alone", () => {
  const next = ids("s");
  const start = createTab(defaultLayout(next), next, "claude");
  const tab = start.tabs[1]!;
  const updated = setPaneSession(start, tab.id, tab.panes[0]!.id, AGENT_SESSION);

  assert.equal(updated.tabs[1]!.panes[0]!.sessionId, AGENT_SESSION);
  assert.deepEqual(updated.tabs[0], start.tabs[0], "other tabs untouched");
});

test("waking or recording against an unknown pane is inert", () => {
  const parsed = parseLayout(storedAgentLayout());
  assert.deepEqual(wakePane(parsed, "t", "nope"), parsed);
  assert.deepEqual(wakePane(parsed, "nope", "p"), parsed);
  assert.deepEqual(setPaneSession(parsed, "t", "nope", AGENT_SESSION), parsed);
});

test("a newly created agent tab is live, not dormant", () => {
  const next = ids("n");
  const created = createTab(defaultLayout(next), next, "claude");
  assert.equal(created.tabs[1]!.panes[0]!.dormant, undefined, "an explicit click starts immediately");
  assert.equal(created.tabs[1]!.panes[0]!.agent, "claude");
});

// --- working directories ---
//
// Every pane used to start in the home directory, so a real day meant retyping `cd` in
// each one and every launched agent began outside the project it was meant to work on.

const PROJECT = "C:\\Users\\SJ\\oikist";

test("a new tab starts where the active tab is, rather than at home", () => {
  const next = ids("c");
  const first = defaultLayout(next, PROJECT);
  const second = createTab(first, next);

  assert.equal(second.tabs[1]!.panes[0]!.cwd, PROJECT);
  assert.equal(activeCwd(second), PROJECT);
});

test("an agent tab inherits the directory too, so it launches inside the project", () => {
  const next = ids("a");
  const created = createTab(defaultLayout(next, PROJECT), next, "claude");
  assert.equal(created.tabs[1]!.panes[0]!.cwd, PROJECT);
});

test("an explicit directory wins over the inherited one", () => {
  const next = ids("e");
  const other = "D:\\work\\other";
  const created = createTab(defaultLayout(next, PROJECT), next, "shell", other);
  assert.equal(created.tabs[1]!.panes[0]!.cwd, other);
});

test("a split pane opens beside its sibling, in the same directory", () => {
  const next = ids("s");
  const start = defaultLayout(next, PROJECT);
  const split = splitTab(start, start.tabs[0]!.id, next);
  assert.equal(split.tabs[0]!.panes[1]!.cwd, PROJECT);
});

test("a file pane's browsed directory is what the next tab inherits", () => {
  const next = ids("f");
  const start = createTab(defaultLayout(next), next, "files", PROJECT);
  assert.equal(start.tabs[1]!.panes[0]!.path, PROJECT, "a file pane browses it rather than runs in it");
  assert.equal(activeCwd(start), PROJECT);
});

test("a shell tab is named for its directory, so several tabs are told apart", () => {
  const next = ids("n");
  assert.equal(defaultLayout(next, PROJECT).tabs[0]!.title, "oikist");
  assert.equal(defaultLayout(next).tabs[0]!.title, "shell", "with no directory the kind is the name");
  assert.equal(defaultLayout(next, "C:\\").tabs[0]!.title, "shell", "a drive root has no leaf to name");
});

test("a stored directory is restored, and a malformed one is dropped", () => {
  const stored = {
    version: 1,
    activeTabId: "t",
    tabs: [
      {
        id: "t",
        title: "oikist",
        activePaneId: "p",
        panes: [
          { id: "p", title: "", cwd: PROJECT },
          { id: "q", title: "", cwd: 7 }
        ]
      }
    ]
  };
  const parsed = parseLayout(stored, ids("z"));
  assert.equal(parsed.tabs[0]!.panes[0]!.cwd, PROJECT);
  assert.equal(parsed.tabs[0]!.panes[1]!.cwd, undefined, "a non-string directory is not carried through");
});

test("a restored agent pane keeps its directory but is still dormant", () => {
  const parsed = parseLayout(
    {
      version: 1,
      activeTabId: "t",
      tabs: [
        {
          id: "t",
          title: "claude",
          activePaneId: "p",
          panes: [{ id: "p", title: "", agent: "claude", cwd: PROJECT, dormant: false }]
        }
      ]
    },
    ids("d")
  );
  assert.equal(parsed.tabs[0]!.panes[0]!.cwd, PROJECT, "resuming must happen in the same project");
  assert.equal(parsed.tabs[0]!.panes[0]!.dormant, true);
});

test("an agent tab names its project, and keeps the provider after it", () => {
  const next = ids("g");
  const created = createTab(defaultLayout(next, PROJECT), next, "claude");
  // The project leads because tab titles truncate from the end: with several agents
  // open, the project is the half that has to survive the ellipsis.
  assert.equal(created.tabs[1]!.title, "oikist · claude");
});

test("an agent tab with no project is named for its provider alone", () => {
  const next = ids("h");
  assert.equal(createTab(defaultLayout(next), next, "claude").tabs[1]!.title, "claude");
});

test("a tab stored before titles named projects is renamed on restore", () => {
  // Otherwise the fix only reaches tabs opened after it, and the tabs already on screen
  // keep saying `claude` for the rest of the day.
  const parsed = parseLayout(
    {
      version: 1,
      activeTabId: "t",
      tabs: [
        {
          id: "t",
          title: "claude",
          activePaneId: "p",
          panes: [{ id: "p", title: "", agent: "claude", cwd: PROJECT }]
        }
      ]
    },
    ids("m")
  );
  assert.equal(parsed.tabs[0]!.title, "oikist · claude");
});

test("a tab that already names its project is left alone", () => {
  const stored = (title: string) => ({
    version: 1,
    activeTabId: "t",
    tabs: [{ id: "t", title, activePaneId: "p", panes: [{ id: "p", title: "", cwd: PROJECT }] }]
  });
  assert.equal(parseLayout(stored("oikist"), ids("k")).tabs[0]!.title, "oikist");
  assert.equal(parseLayout(stored("something else"), ids("k")).tabs[0]!.title, "something else");
});

test("a tab with no directory keeps the bare title it was stored with", () => {
  const parsed = parseLayout(
    {
      version: 1,
      activeTabId: "t",
      tabs: [{ id: "t", title: "claude", activePaneId: "p", panes: [{ id: "p", title: "", agent: "claude" }] }]
    },
    ids("j")
  );
  assert.equal(parsed.tabs[0]!.title, "claude");
});

test("a files or handoff tab names its project too", () => {
  const next = ids("v");
  const base = defaultLayout(next, PROJECT);
  assert.equal(createTab(base, next, "files").tabs[1]!.title, "oikist · files");
  assert.equal(createTab(base, next, "handoff").tabs[1]!.title, "oikist · handoff");
});

test("a stored files tab is renamed from the directory it was browsing", () => {
  // A file pane records `path` rather than `cwd` — the directory it browses is the one a
  // terminal beside it would start in, so it is what names the tab.
  const parsed = parseLayout(
    {
      version: 1,
      activeTabId: "t",
      tabs: [
        {
          id: "t",
          title: "files",
          activePaneId: "p",
          panes: [{ id: "p", title: "", view: "files", path: PROJECT }]
        }
      ]
    },
    ids("w")
  );
  assert.equal(parsed.tabs[0]!.title, "oikist · files");
});

/*
 * Tiling. Section 5's escape clause fired on day 2: "the windows feel rigid, I miss the
 * modularity of the window panes of Wave."
 *
 * Arrangement is a tree of pane *ids*, held beside the flat pane list rather than
 * replacing it — see docs/PHASE-3-tiling.md for why that choice is load-bearing for
 * parseLayout's repair posture.
 */
test("a fresh tab arranges its single pane as one leaf", () => {
  const layout = defaultLayout(ids("p"));
  const tab = layout.tabs[0]!;
  assert.deepEqual(tab.arrangement, { kind: "leaf", paneId: tab.panes[0]!.id });
});

test("splitting a pane replaces its leaf with a split holding both", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  const tab = layout.tabs[0]!;
  const first = tab.panes[0]!.id;

  layout = splitPane(layout, tab.id, first, "row", next);
  const after = layout.tabs[0]!;
  assert.equal(after.panes.length, 2, "a new pane joins the flat list");
  assert.equal(after.arrangement.kind, "split");
  if (after.arrangement.kind !== "split") return;
  assert.equal(after.arrangement.direction, "row");
  assert.deepEqual(after.arrangement.children[0], { kind: "leaf", paneId: first });
  assert.equal(after.arrangement.children[1]!.kind, "leaf");
});

test("splitting nests, so three panes are two splits deep", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  const tab = layout.tabs[0]!;
  layout = splitPane(layout, tab.id, tab.panes[0]!.id, "row", next);
  const second = layout.tabs[0]!.panes[1]!.id;
  layout = splitPane(layout, tab.id, second, "column", next);

  assert.equal(layout.tabs[0]!.panes.length, 3);
  const root = layout.tabs[0]!.arrangement;
  assert.equal(root.kind, "split");
  if (root.kind !== "split") return;
  assert.equal(root.children[1]!.kind, "split", "the split happened at the second pane");
});

test("closing a pane collapses its split, leaving the sibling in place", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  const tab = layout.tabs[0]!;
  const first = tab.panes[0]!.id;
  layout = splitPane(layout, tab.id, first, "row", next);
  const second = layout.tabs[0]!.panes[1]!.id;

  layout = closePane(layout, tab.id, second, next);
  assert.equal(layout.tabs[0]!.panes.length, 1);
  assert.deepEqual(layout.tabs[0]!.arrangement, { kind: "leaf", paneId: first });
});

test("a ratio is clamped so a pane can never be dragged to nothing", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  const tab = layout.tabs[0]!;
  layout = splitPane(layout, tab.id, tab.panes[0]!.id, "row", next);

  layout = setRatio(layout, tab.id, [], 0.001);
  const root = layout.tabs[0]!.arrangement;
  assert.equal(root.kind, "split");
  if (root.kind !== "split") return;
  assert.ok(root.ratio >= 0.1 && root.ratio <= 0.9, `ratio clamped, got ${root.ratio}`);
});

/** Temporary: it hides the others, it does not rearrange them. */
test("maximising records the pane and leaves the arrangement untouched", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  const tab = layout.tabs[0]!;
  const first = tab.panes[0]!.id;
  layout = splitPane(layout, tab.id, first, "row", next);
  const before = layout.tabs[0]!.arrangement;

  layout = toggleMaximized(layout, tab.id, first);
  assert.equal(layout.tabs[0]!.maximizedPaneId, first);
  assert.equal(layout.tabs[0]!.arrangement, before, "the tree is identical, not rebuilt");

  layout = toggleMaximized(layout, tab.id, first);
  assert.equal(layout.tabs[0]!.maximizedPaneId, undefined);
});

test("closing the maximised pane clears the maximise", () => {
  const next = ids("p");
  let layout = defaultLayout(next);
  const tab = layout.tabs[0]!;
  layout = splitPane(layout, tab.id, tab.panes[0]!.id, "row", next);
  const second = layout.tabs[0]!.panes[1]!.id;
  layout = toggleMaximized(layout, tab.id, second);

  layout = closePane(layout, tab.id, second, next);
  assert.equal(layout.tabs[0]!.maximizedPaneId, undefined, "nothing may stay maximised once it is gone");
});

/**
 * A layout stored before tiling existed has no arrangement at all. It must open, arranged
 * as it was, rather than being discarded — the flat list is enough to rebuild from.
 */
test("a stored layout with no arrangement is given one", () => {
  const stored = {
    version: 1,
    activeTabId: "t1",
    tabs: [
      {
        id: "t1",
        title: "shell",
        activePaneId: "a",
        panes: [
          { id: "a", title: "shell" },
          { id: "b", title: "shell" }
        ]
      }
    ]
  };
  const layout = parseLayout(stored, ids("x"));
  const tab = layout.tabs[0]!;
  assert.equal(tab.panes.length, 2);
  assert.equal(tab.arrangement.kind, "split", "two panes become a split, not a lost pane");
});

test("an arrangement naming a pane that does not exist is repaired, not thrown on", () => {
  const stored = {
    version: 1,
    activeTabId: "t1",
    tabs: [
      {
        id: "t1",
        title: "shell",
        activePaneId: "a",
        panes: [{ id: "a", title: "shell" }],
        arrangement: {
          kind: "split",
          direction: "row",
          ratio: 0.5,
          children: [
            { kind: "leaf", paneId: "a" },
            { kind: "leaf", paneId: "ghost" }
          ]
        }
      }
    ]
  };
  const layout = parseLayout(stored, ids("x"));
  assert.deepEqual(layout.tabs[0]!.arrangement, { kind: "leaf", paneId: "a" });
});

test("a pane missing from the arrangement is appended rather than orphaned", () => {
  const stored = {
    version: 1,
    activeTabId: "t1",
    tabs: [
      {
        id: "t1",
        title: "shell",
        activePaneId: "a",
        panes: [
          { id: "a", title: "shell" },
          { id: "b", title: "shell" }
        ],
        arrangement: { kind: "leaf", paneId: "a" }
      }
    ]
  };
  const layout = parseLayout(stored, ids("x"));
  const tab = layout.tabs[0]!;
  assert.equal(tab.panes.length, 2, "the pane survives");
  assert.equal(tab.arrangement.kind, "split", "and becomes visible");
});


/*
 * Geometry, so the DOM never nests.
 *
 * Rendering the tree as nested elements would move a pane to a new position in the React
 * tree every time it split, remounting it — and a remounted agent pane tears down a live
 * session. Panes are therefore rendered flat and absolutely positioned from these rects,
 * so splitting changes styles and never structure.
 */
test("a single pane fills the tab", () => {
  const { panes, dividers } = layoutRects({ kind: "leaf", paneId: "a" });
  assert.deepEqual(panes, [{ paneId: "a", left: 0, top: 0, width: 100, height: 100 }]);
  assert.equal(dividers.length, 0, "nothing to drag with one pane");
});

test("a row split puts panes side by side at the ratio", () => {
  const { panes } = layoutRects({
    kind: "split",
    direction: "row",
    ratio: 0.25,
    children: [{ kind: "leaf", paneId: "a" }, { kind: "leaf", paneId: "b" }]
  });
  assert.deepEqual(panes[0], { paneId: "a", left: 0, top: 0, width: 25, height: 100 });
  assert.deepEqual(panes[1], { paneId: "b", left: 25, top: 0, width: 75, height: 100 });
});

test("a column split stacks them", () => {
  const { panes } = layoutRects({
    kind: "split",
    direction: "column",
    ratio: 0.5,
    children: [{ kind: "leaf", paneId: "a" }, { kind: "leaf", paneId: "b" }]
  });
  assert.deepEqual(panes[0], { paneId: "a", left: 0, top: 0, width: 100, height: 50 });
  assert.deepEqual(panes[1], { paneId: "b", left: 0, top: 50, width: 100, height: 50 });
});

test("nesting subdivides only the child it belongs to", () => {
  const { panes } = layoutRects({
    kind: "split",
    direction: "row",
    ratio: 0.5,
    children: [
      { kind: "leaf", paneId: "a" },
      {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        children: [{ kind: "leaf", paneId: "b" }, { kind: "leaf", paneId: "c" }]
      }
    ]
  });
  assert.deepEqual(panes[0], { paneId: "a", left: 0, top: 0, width: 50, height: 100 });
  assert.deepEqual(panes[1], { paneId: "b", left: 50, top: 0, width: 50, height: 50 });
  assert.deepEqual(panes[2], { paneId: "c", left: 50, top: 50, width: 50, height: 50 });
});

test("every split yields one divider, addressed by its path", () => {
  const { dividers } = layoutRects({
    kind: "split",
    direction: "row",
    ratio: 0.5,
    children: [
      { kind: "leaf", paneId: "a" },
      {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        children: [{ kind: "leaf", paneId: "b" }, { kind: "leaf", paneId: "c" }]
      }
    ]
  });
  assert.equal(dividers.length, 2);
  assert.deepEqual(dividers[0]?.path, [], "the root split");
  assert.deepEqual(dividers[1]?.path, [1], "the split inside the right child");
  assert.equal(dividers[1]?.direction, "column");
});


/** A nested divider must measure against its own split, not the whole tab. */
test("a divider knows the span it divides", () => {
  const { dividers } = layoutRects({
    kind: "split",
    direction: "row",
    ratio: 0.5,
    children: [
      { kind: "leaf", paneId: "a" },
      {
        kind: "split",
        direction: "row",
        ratio: 0.5,
        children: [{ kind: "leaf", paneId: "b" }, { kind: "leaf", paneId: "c" }]
      }
    ]
  });
  assert.equal(dividers[0]?.origin, 0);
  assert.equal(dividers[0]?.span, 100, "the root divides the whole width");
  assert.equal(dividers[1]?.origin, 50, "the nested one starts halfway across");
  assert.equal(dividers[1]?.span, 50, "and divides only its own half");
});
