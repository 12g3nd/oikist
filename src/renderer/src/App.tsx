import { useCallback, useEffect, useRef, useState } from "react";

import {
  MAX_PANES_PER_TAB,
  activeCwd,
  closeTab,
  createTab,
  defaultLayout,
  parseLayout,
  setActivePane,
  setActiveTab,
  setPanePath,
  setPaneSession,
  splitTab,
  unsplitPane,
  wakePane,
  type LayoutState,
  type PaneState
} from "../../shared/layout.js";
import { AgentRail } from "./AgentRail.js";
import { FileViewer } from "./FileViewer.js";
import { Handoff } from "./Handoff.js";
import { AgentSessionPane } from "./AgentSession.js";
import { TerminalPane } from "./Terminal.js";

const newId = (): string => crypto.randomUUID();

/** The trailing directory name — the part a person uses to say which project. */
function leafOf(path: string): string {
  const parts = path.split(/[/\\]+/).filter((part) => part !== "");
  return parts.at(-1) ?? path;
}

export function App(): React.JSX.Element {
  const [layout, setLayout] = useState<LayoutState | null>(null);

  /*
   * Text waiting in a pane's composer, keyed by pane id.
   *
   * Held here rather than in the layout because it must never be persisted: a handoff
   * block restored days later, still unsent, would be worse than no handoff at all. It
   * is consumed once, by the pane that opens for it.
   */
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, string>>({});

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
  const layoutRef = useRef<LayoutState | null>(null);
  layoutRef.current = layout;

  /**
   * Opens a project: the OS picker, then a shell tab already inside it.
   *
   * A new tab rather than a change to this one, because a shell that is already running
   * cannot be moved — pretending otherwise would show a directory the prompt disagrees
   * with. Everything opened afterwards inherits it.
   */
  const openProject = useCallback((): void => {
    const startIn = layoutRef.current === null ? undefined : activeCwd(layoutRef.current);
    void window.oikist.files
      .choose(startIn)
      .then((chosen) => {
        if (chosen !== null) {
          apply((current) => createTab(current, newId, "shell", chosen));
        }
      })
      .catch(() => {
        /* a picker that will not open is not worth an error state in the tab bar */
      });
  }, [apply]);

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

  // The tab strip scrolls once there are more tabs than fit, so a newly created tab —
  // which takes focus immediately — would otherwise be made active somewhere off the
  // right edge, looking like the click did nothing.
  const activeTabElement = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabElement.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [layout?.activeTabId, layout?.tabs.length]);

  if (layout === null) {
    return <div className="shell shell--loading">restoring…</div>;
  }

  const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0]!;
  const here = activeCwd(layout);

  return (
    <div className="shell">
      <AgentRail />

      <main className="main">
        <div className="tabbar">
          {/*
            Tabs scroll on their own so the controls beside them stay put. Sharing one
            flex row squeezed every tab until its title truncated — `oikist · claude`
            became `oikist · cl…`, which is the half worth keeping cut off — and wrapped
            the buttons onto a second line.
          */}
          <div className="tabbar-tabs" role="tablist" aria-label="Terminal tabs">
          {layout.tabs.map((tab) => (
            <div
              key={tab.id}
              ref={tab.id === activeTab.id ? activeTabElement : null}
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
          </div>

          <div className="tabbar-actions">
          {/*
            Where new panes will start. Shown rather than assumed: everything opened from
            this bar inherits it, so it has to be visible before it is inherited.
          */}
          <button
            className="tabbar-cwd"
            type="button"
            onClick={openProject}
            title={`${here ?? "Home directory"} — click to open another project in a new tab`}
          >
            <span className="tabbar-cwd-label">{here === undefined ? "~" : leafOf(here)}</span>
          </button>

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
          <button
            className="tabbar-action tabbar-action--agent"
            type="button"
            onClick={() => apply((current) => createTab(current, newId, "claude"))}
            title="New Claude agent — launched by oikist, so it reports its own state"
          >
            + Claude
          </button>
          <button
            className="tabbar-action tabbar-action--agent"
            type="button"
            onClick={() => apply((current) => createTab(current, newId, "codex"))}
            title="New Codex session — oikist starts it, but Codex publishes no live state for it on Windows"
          >
            + Codex
          </button>
          <button
            className="tabbar-action tabbar-action--files"
            type="button"
            onClick={() => apply((current) => createTab(current, newId, "files"))}
            title="Read files — read-only"
          >
            + Files
          </button>
          <button
            className="tabbar-action tabbar-action--files"
            type="button"
            onClick={() => apply((current) => createTab(current, newId, "handoff"))}
            title="Move a task between providers"
          >
            + Handoff
          </button>
          </div>
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
                {pane.view === "handoff" ? (
                  <Handoff
                    {...(pane.path === undefined ? {} : { cwd: pane.path })}
                    onCwdChange={(next) => apply((current) => setPanePath(current, tab.id, pane.id, next))}
                    onOpenIn={(provider, text) => {
                      const paneId = newId();
                      setPendingDrafts((current) => ({ ...current, [paneId]: text }));
                      apply((current) => createTab(current, () => paneId, provider, pane.path ?? here));
                    }}
                  />
                ) : pane.view === "files" ? (
                  <FileViewer
                    {...(pane.path === undefined ? {} : { path: pane.path })}
                    onPathChange={(next) => apply((current) => setPanePath(current, tab.id, pane.id, next))}
                    onOpenHere={(next) => apply((current) => createTab(current, newId, "shell", next))}
                  />
                ) : pane.dormant === true ? (
                  <DormantAgent pane={pane} onResume={() => apply((current) => wakePane(current, tab.id, pane.id))} />
                ) : pane.agent !== undefined ? (
                  // Agent panes are conversations, not terminals. Both providers are
                  // driven over their own JSON event streams; only shells keep a pty.
                  <AgentSessionPane
                    provider={pane.agent}
                    {...(pendingDrafts[pane.id] === undefined ? {} : { initialDraft: pendingDrafts[pane.id] })}
                    onDraftConsumed={() =>
                      setPendingDrafts(({ [pane.id]: _taken, ...rest }) => rest)
                    }
                    focused={tab.id === activeTab.id && pane.id === tab.activePaneId}
                    {...(pane.cwd === undefined ? {} : { cwd: pane.cwd })}
                    {...(pane.sessionId === undefined ? {} : { resumeSessionId: pane.sessionId })}
                    onAgentSession={(sessionId) =>
                      apply((current) => setPaneSession(current, tab.id, pane.id, sessionId))
                    }
                  />
                ) : (
                  <TerminalPane
                    focused={tab.id === activeTab.id && pane.id === tab.activePaneId}
                    {...(pane.cwd === undefined ? {} : { cwd: pane.cwd })}
                    {...(pane.agent === undefined ? {} : { agent: pane.agent })}
                    {...(pane.sessionId === undefined ? {} : { resumeSessionId: pane.sessionId })}
                    onAgentSession={(sessionId) =>
                      apply((current) => setPaneSession(current, tab.id, pane.id, sessionId))
                    }
                    onExit={() => apply((current) => unsplitPane(current, tab.id, pane.id, newId))}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </main>
    </div>
  );
}

/**
 * A restored agent pane, waiting to be asked.
 *
 * Restoring never starts an agent: launching costs quota the moment the app opens, and
 * an agent resuming work nobody is watching is worse than one that waits. The pane says
 * what it was and what clicking will do, so nothing happens by surprise.
 */
function DormantAgent({ pane, onResume }: { pane: PaneState; onResume: () => void }): React.JSX.Element {
  // Codex is never resumable here: oikist cannot assign or recover a Codex thread id on
  // Windows, so the only honest offer is a new session.
  const resumable = pane.sessionId !== undefined && pane.agent !== "codex";
  return (
    <div className="dormant">
      <span className="dormant-provider">{(pane.agent ?? "agent").toUpperCase()}</span>
      <p className="dormant-note">
        {resumable
          ? "Not running. Its conversation is on disk and can be picked up where it stopped."
          : pane.agent === "codex"
            ? "Not running. Codex sessions cannot be resumed from here, so this starts a new one."
            : "Not running. No previous session was recorded, so this starts a new one."}
      </p>
      {pane.cwd !== undefined && (
        <p className="dormant-where" title={pane.cwd}>
          in <code>{leafOf(pane.cwd)}</code>
        </p>
      )}
      <button className="dormant-action" type="button" onClick={onResume}>
        {resumable ? "Resume session" : "Start agent"}
      </button>
      {resumable && <code className="dormant-id">{pane.sessionId?.slice(0, 8)}</code>}
    </div>
  );
}
