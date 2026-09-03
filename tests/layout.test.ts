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
  splitTab,
  unsplitPane
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
