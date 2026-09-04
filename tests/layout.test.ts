import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PANES_PER_TAB,
  closeTab,
  createTab,
  defaultLayout,
  parseLayout,
  setActivePane,
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

test("splitting adds a second pane and focuses it; splitting again is a no-op", () => {
  const next = ids("p");
  const start = defaultLayout(next);
  const split = splitTab(start, start.activeTabId!, next);

  assert.equal(split.tabs[0]?.panes.length, 2);
  assert.equal(split.tabs[0]?.activePaneId, split.tabs[0]?.panes[1]?.id, "the new pane takes focus");

  const again = splitTab(split, split.activeTabId!, next);
  assert.equal(again.tabs[0]?.panes.length, MAX_PANES_PER_TAB, "never more than a 2-up split");
  assert.deepEqual(again, split, "a no-op returns an equal layout");
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
