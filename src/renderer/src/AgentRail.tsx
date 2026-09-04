import { useEffect, useState } from "react";

import type { AgentSummary } from "../../shared/agents.js";
import type { AgentsSnapshot } from "../../shared/ipc.js";

const GLYPH: Record<AgentSummary["activity"], string> = {
  needsPermission: "!",
  waitingForInput: "?",
  working: "●",
  idle: "·",
  unknown: "○"
};

const ACTIVITY_LABEL: Record<AgentSummary["activity"], string> = {
  needsPermission: "NEEDS PERMISSION",
  waitingForInput: "WAITING",
  working: "WORKING",
  idle: "IDLE",
  unknown: "STATE UNKNOWN"
};

function age(startedAt: number): string {
  if (startedAt <= 0) {
    return "";
  }
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (minutes < 60 * 24) {
    return `${Math.round(minutes / 60)}h`;
  }
  return `${Math.round(minutes / (60 * 24))}d`;
}

/**
 * The spine of the app: which agents exist, and which one needs you.
 *
 * Rows are sorted attention-first in the shared model, so the top row is always the
 * most urgent. Every row states how it is known — an agent oikist launched reports its
 * own state, one merely found running does not — because a status panel that presents
 * a guess as a fact stops being believed the first time it is wrong.
 */
export function AgentRail(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.oikist.agents
      .list()
      .then((initial) => {
        if (!cancelled) {
          setSnapshot(initial);
        }
      })
      .catch(() => {
        // The push subscription below is the real source; a failed first read just
        // leaves the rail saying "looking" until the next pass.
      });

    const off = window.oikist.agents.onUpdate((next) => setSnapshot(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const agents = snapshot?.agents ?? [];

  return (
    <aside className="rail" aria-label="Agents">
      <div className="rail-head">
        <span className="rail-label">AGENTS</span>
        <span className="rail-count">{snapshot === null ? "" : `// ${agents.length}`}</span>
      </div>

      {snapshot !== null && !snapshot.ok && (
        <p className="rail-alert" role="alert">
          CLAUDE COULD NOT BE CONSULTED — SHOWING LAST KNOWN
        </p>
      )}

      {snapshot === null && <p className="rail-empty">Looking for agents…</p>}

      {snapshot !== null && agents.length === 0 && (
        <p className="rail-empty">
          No agents running. Sessions started anywhere on this machine appear here.
        </p>
      )}

      <ul className="agent-list">
        {agents.map((agent) => (
          <li key={agent.sessionId} className="agent" data-activity={agent.activity}>
            <div className="agent-line">
              <span className="agent-glyph" aria-hidden="true">
                {GLYPH[agent.activity]}
              </span>
              <span className="agent-provider">{agent.provider.toUpperCase()}</span>
              <span className="agent-age">{age(agent.startedAt)}</span>
            </div>
            <div className="agent-title" title={agent.cwd ?? agent.title}>
              {agent.title}
            </div>
            {agent.subagents !== undefined && agent.subagents.active > 0 && (
              <div className="agent-subagents" title={agent.subagents.labels.join(", ")}>
                <span className="agent-branch" aria-hidden="true">
                  ⌥
                </span>
                {agent.subagents.active} subagent{agent.subagents.active === 1 ? "" : "s"}
                {agent.subagents.labels.length > 0 && (
                  <span className="agent-subagent-names">{agent.subagents.labels.join(" · ")}</span>
                )}
              </div>
            )}
            <div className="agent-meta">
              <span className="agent-state">{ACTIVITY_LABEL[agent.activity]}</span>
              {/*
                Provenance, not decoration. "attached" means oikist found this agent
                rather than starting it, so it has no hooks and cannot report activity.
              */}
              <span className={`agent-origin agent-origin--${agent.origin}`}>
                {agent.origin === "launched" ? "launched" : "~attached"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
