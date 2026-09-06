import { useEffect, useRef, useState } from "react";

import {
  composeHandoff,
  handoffProblem,
  type HandoffProvider,
  type WorkingState
} from "../../shared/handoff.js";
import type { ProviderLimits } from "../../shared/limits.js";

interface HandoffProps {
  /** The repository whose working state travels with the handoff. */
  readonly cwd?: string;
  readonly onCwdChange: (cwd: string) => void;
}

const PROVIDERS: readonly HandoffProvider[] = ["claude", "codex"];

function resetLabel(resetsAt: number | null): string {
  if (resetsAt === null) {
    return "";
  }
  const hours = (resetsAt * 1000 - Date.now()) / 3_600_000;
  if (hours <= 0) {
    return "now";
  }
  return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
}

/**
 * Moving a task between providers.
 *
 * The block is composed here and put on the clipboard rather than typed into the other
 * agent automatically. Pasting is where the person reads what is about to be sent, and
 * a handoff is exactly the kind of thing that should not happen without being read.
 */
export function Handoff({ cwd, onCwdChange }: HandoffProps): React.JSX.Element {
  const [from, setFrom] = useState<HandoffProvider>("claude");
  const [to, setTo] = useState<HandoffProvider>("codex");
  const [task, setTask] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<WorkingState | null>(null);
  const [limits, setLimits] = useState<readonly ProviderLimits[] | null>(null);
  const [copied, setCopied] = useState(false);

  // A ref, not a dependency: an inline arrow from the parent would re-run the effect on
  // every render and reset the note being typed.
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  useEffect(() => {
    const target = cwd ?? "";
    if (target === "") {
      window.oikist.files.home().then((home) => onCwdChangeRef.current(home)).catch(() => {});
      return;
    }
    window.oikist.handoff.state(target).then(setState).catch(() => setState(null));
  }, [cwd]);

  useEffect(() => {
    window.oikist.handoff.limits().then(setLimits).catch(() => setLimits(null));
  }, []);

  const problem = handoffProblem({ note });
  const composed =
    state === null ? "" : composeHandoff({ ...state, from, to, task, note });

  const swap = (): void => {
    setFrom(to);
    setTo(from);
  };

  return (
    <div className="handoff">
      <section className="handoff-limits">
        <span className="handoff-label">What is left</span>
        <ul className="limit-list">
          {limits === null && <li className="handoff-note">Asking each provider…</li>}
          {limits?.map((limit) => (
            <li key={limit.provider} className="limit">
              <span className="limit-provider">{limit.provider.toUpperCase()}</span>
              {limit.known ? (
                <span className="limit-windows">
                  {limit.primary !== undefined && (
                    <span className={limit.primary.usedPercent >= 90 ? "limit-hot" : ""}>
                      {limit.primary.usedPercent}% used · resets {resetLabel(limit.primary.resetsAt)}
                    </span>
                  )}
                  {limit.secondary !== undefined && (
                    <span className={limit.secondary.usedPercent >= 90 ? "limit-hot" : ""}>
                      weekly {limit.secondary.usedPercent}% · resets {resetLabel(limit.secondary.resetsAt)}
                    </span>
                  )}
                </span>
              ) : (
                <span className="handoff-note">{limit.note ?? "No usage is published."}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="handoff-direction">
        <select value={from} onChange={(event) => setFrom(event.target.value as HandoffProvider)}>
          {PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        <button type="button" className="handoff-swap" onClick={swap} title="Swap direction">
          →
        </button>
        <select value={to} onChange={(event) => setTo(event.target.value as HandoffProvider)}>
          {PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        <span className="handoff-cwd" title={state?.worktree ?? ""}>
          {state === null ? "" : `${state.branch} · ${state.files.length} changed`}
        </span>
      </div>

      <label className="handoff-field">
        <span className="handoff-label">Task</span>
        <textarea
          rows={2}
          value={task}
          placeholder="What was being attempted."
          onChange={(event) => setTask(event.target.value)}
        />
      </label>

      <label className="handoff-field">
        <span className="handoff-label">Where I got to</span>
        <textarea
          rows={5}
          value={note}
          placeholder="Ask the outgoing agent to write this: what it tried, what failed, what is left."
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <div className="handoff-actions">
        <button
          type="button"
          className="handoff-copy"
          disabled={problem !== null || state === null}
          onClick={() => {
            void window.oikist.handoff.copy(composed).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? "Copied" : "Copy handoff"}
        </button>
        {problem !== null && <span className="handoff-problem">{problem}</span>}
      </div>

      <pre className="handoff-preview">{composed || "…"}</pre>
    </div>
  );
}
