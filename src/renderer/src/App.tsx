import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_PANES_PER_TAB,
  closeTab,
  createTab,
  defaultLayout,
  parseLayout,
  setActivePane,
  setActiveTab,
  splitTab,
  unsplitPane,
  type LayoutState
} from "../../shared/layout.js";
import { AgentRail } from "./AgentRail.js";
import { TerminalPane } from "./Terminal.js";

const newId = (): string => crypto.randomUUID();

export function App(): React.JSX.Element {
  const [layout, setLayout] = useState<LayoutState | null>(null);

  // Restored before the first paint of any terminal, so panes are created once with
  // their real identities rather than created for a default layout and then replaced.
  useEffect(() => {
    let cancelled = false;
    window.oikist.layout
      .load()
      .then((stored) => {
        if (!cancelled) {
          setLayout(parseLayout(stored, newId));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLayout(defaultLayout(newId));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved on change rather than on quit: the app can be killed without losing the
  // arrangement, and the write is debounced and made atomic in the main process.
  useEffect(() => {
    if (layout !== null) {
      window.oikist.layout.save(layout);
    }
  }, [layout]);

  const apply = useCallback((change: (current: LayoutState) => LayoutState): void => {
    setLayout((current) => (current === null ? current : change(current)));
  }, []);

  const activeTabRef = useRef<string | null>(null);
  activeTabRef.current = layout?.activeTabId ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || !event.shiftKey) {
        return;
      }
      const tabId = activeTabRef.current;
      const key = event.key.toLowerCase();
      if (key === "t") {
        apply((current) => createTab(current, newId));
      } else if (key === "e" && tabId !== null) {
        apply((current) => splitTab(current, tabId, newId));
      } else if (key === "w" && tabId !== null) {
        apply((current) => {
          const tab = current.tabs.find((candidate) => candidate.id === tabId);
          return tab === undefined ? current : unsplitPane(current, tabId, tab.activePaneId, newId);
        });
      } else {
        return;
      }
      // Only prevented for chords actually handled, so every other key still reaches
      // the terminal.
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply]);

  if (layout === null) {
    return <div className="shell shell--loading">restoring…</div>;
  }

  const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0]!;

  return (
    <div className="shell">
      <AgentRail />

      <main className="main">
        <div className="tabbar" role="tablist" aria-label="Terminal tabs">
          {layout.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab${tab.id === activeTab.id ? " tab--active" : ""}`}
              role="tab"
              aria-selected={tab.id === activeTab.id}
              tabIndex={0}
              onClick={() => apply((current) => setActiveTab(current, tab.id))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  apply((current) => setActiveTab(current, tab.id));
                }
              }}
            >
              <span className="tab-title">{tab.title}</span>
              {tab.panes.length > 1 && <span className="tab-split" title="split">◫</span>}
              <button
                className="tab-close"
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  apply((current) => closeTab(current, tab.id, newId));
                }}
              >
                ×
              </button>
            </div>
          ))}

          <button
            className="tabbar-action"
            type="button"
            onClick={() => apply((current) => createTab(current, newId))}
            title="New tab — Ctrl+Shift+T"
          >
            +
          </button>
          <button
            className="tabbar-action"
            type="button"
            disabled={activeTab.panes.length >= MAX_PANES_PER_TAB}
            onClick={() => apply((current) => splitTab(current, activeTab.id, newId))}
            title="Split — Ctrl+Shift+E"
          >
            ◫
          </button>
        </div>

        {/*
          Every tab stays mounted so its shell keeps running while you look at another
          one; only the active tab is displayed. A hidden pane has zero size, which the
          terminal's resize observer ignores rather than fitting to zero columns.
        */}
        {layout.tabs.map((tab) => (
          <div
            key={tab.id}
            className={`panes${tab.panes.length > 1 ? " panes--split" : ""}`}
            hidden={tab.id !== activeTab.id}
          >
            {tab.panes.map((pane) => (
              <div
                key={pane.id}
                className={`pane${pane.id === tab.activePaneId && tab.panes.length > 1 ? " pane--focused" : ""}`}
                onFocusCapture={() => apply((current) => setActivePane(current, tab.id, pane.id))}
                onMouseDown={() => apply((current) => setActivePane(current, tab.id, pane.id))}
              >
                <TerminalPane
                  focused={tab.id === activeTab.id && pane.id === tab.activePaneId}
                  onExit={() => apply((current) => unsplitPane(current, tab.id, pane.id, newId))}
                />
              </div>
            ))}
          </div>
        ))}
      </main>
    </div>
  );
}
