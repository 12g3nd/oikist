import { useEffect, useMemo, useRef, useState } from "react";

import { emptySession, type SessionState, type SessionTurn } from "../../shared/session.js";

interface AgentSessionPaneProps {
  readonly provider: "claude" | "codex";
  /** Marks which pane owns keyboard focus; only the focused pane takes input. */
  readonly focused: boolean;
  /** Where the agent starts. Absent means the home directory. */
  readonly cwd?: string;
  /** Resume this conversation rather than starting a new one. */
  readonly resumeSessionId?: string;
  /** Reports the session this pane ended up running, so it can be resumed later. */
  readonly onAgentSession?: (sessionId: string) => void;
  readonly onExit?: (exitCode: number) => void;
}

/**
 * A Claude session as a conversation rather than a character grid.
 *
 * This is the change section 10 of `DECISIONS.md` exists for. The four input complaints
 * that sent a day's work to VS Code — no caret, no clicking into typed text, no markdown,
 * no attachments — are all properties of a ConPTY grid, and all of them disappear the
 * moment the composer is a real `textarea`. The agent underneath is the same `claude`
 * binary; only the transport changed.
 */
export function AgentSessionPane({
  provider,
  focused,
  cwd,
  resumeSessionId,
  onAgentSession,
  onExit
}: AgentSessionPaneProps): React.JSX.Element {
  const [state, setState] = useState<SessionState>(emptySession());
  const [exitCode, setExitCode] = useState<number | null>(null);
  /*
   * Whether the child process exists, which is *not* the same as having heard from it.
   * `init` arrives per turn, so a session that has never been spoken to emits nothing at
   * all — reading readiness off `sessionId` left the pane saying "Starting Claude…"
   * forever, which the first screenshot caught.
   */
  const [started, setStarted] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<readonly string[]>([]);

  const idRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  /*
   * Everything the parent supplies is held in a ref and kept out of the effect below.
   *
   * This has bitten three times: `onExit` recreated ptys, `onPathChange` cleared the file
   * being read, and `resumeSessionId` — which the pane itself reports upward — came back
   * down and relaunched the agent for a session created seconds earlier. A value that
   * round-trips through the parent must never be a dependency.
   */
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onAgentSessionRef = useRef(onAgentSession);
  onAgentSessionRef.current = onAgentSession;
  const providerRef = useRef(provider);
  const cwdRef = useRef(cwd);
  const resumeRef = useRef(resumeSessionId);

  useEffect(() => {
    let cancelled = false;

    const offEvent = window.oikist.session.onEvent((message) => {
      if (message.id === idRef.current) {
        setState(message.state);
      }
    });
    const offExit = window.oikist.session.onExit((message) => {
      if (message.id !== idRef.current) {
        return;
      }
      setExitCode(message.exitCode);
      onExitRef.current?.(message.exitCode);
    });

    void window.oikist.session
      .start({
        provider: providerRef.current,
        ...(cwdRef.current === undefined ? {} : { cwd: cwdRef.current }),
        ...(resumeRef.current === undefined ? {} : { resumeSessionId: resumeRef.current })
      })
      .then(({ id, agentSessionId }) => {
        // A pane unmounted before its session answered must not leave a process behind.
        if (cancelled) {
          window.oikist.session.dispose(id);
          return;
        }
        idRef.current = id;
        setStarted(true);
        onAgentSessionRef.current?.(agentSessionId);
      })
      .catch((error: unknown) => {
        setExitCode(-1);
        setState((current) => ({
          ...current,
          statusDetail: error instanceof Error ? error.message : String(error)
        }));
      });

    return () => {
      cancelled = true;
      offEvent();
      offExit();
      if (idRef.current !== null) {
        window.oikist.session.dispose(idRef.current);
        idRef.current = null;
      }
    };
    // Deliberately empty: a session starts once, when its pane appears.
  }, []);

  useEffect(() => {
    if (focused) {
      composerRef.current?.focus();
    }
  }, [focused]);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [state.turns.length, state.activity]);

  /**
   * Slash commands the CLI itself published.
   *
   * Empty until the first `init` arrives, which is after the first turn is sent — so the
   * very first prompt has no autocomplete. That is a property of the stream, not a bug
   * to work around by guessing at a command list.
   */
  const suggestions = useMemo(() => {
    const match = /^\/([a-z0-9:_-]*)$/i.exec(draft);
    if (match === null) {
      return [];
    }
    const prefix = (match[1] ?? "").toLowerCase();
    return state.slashCommands.filter((name) => name.toLowerCase().startsWith(prefix)).slice(0, 8);
  }, [draft, state.slashCommands]);

  const running = exitCode === null;
  const label = provider === "codex" ? "Codex" : "Claude";

  function send(): void {
    const id = idRef.current;
    const body = draft.trim();
    if (id === null || !running || (body === "" && attachments.length === 0)) {
      return;
    }
    // Attachments are sent as paths the agent can read for itself, which is what its own
    // tools already do. Nothing is uploaded and no file content passes through oikist.
    const text = [...attachments.map((path) => `@${path}`), body].filter((part) => part !== "").join("\n");
    window.oikist.session.send(id, text);
    setDraft("");
    setAttachments([]);
  }

  async function attach(): Promise<void> {
    const chosen = await window.oikist.files.chooseFiles(cwdRef.current);
    if (chosen.length > 0) {
      setAttachments((current) => [...current, ...chosen.filter((path) => !current.includes(path))]);
    }
  }

  return (
    <div className="agent">
      <div className="agent-scroll">
        {state.turns.length === 0 && running && (
          <p className="agent-empty">
            {started ? "Ready. Type below to begin." : `Starting ${label}…`}
          </p>
        )}
        {state.turns.map((turn, index) => (
          <Turn key={index} turn={turn} label={label} />
        ))}
        {state.activity === "working" && running && <p className="agent-working">Working…</p>}
        {/*
          Shown whenever the agent has something to say about its own state, not only
          when it wants the human. A Codex turn that fails reports why through
          `turn.failed` and goes idle, so gating this on `needsAction` made a failed turn
          completely silent — the pane showed the question and nothing else.
        */}
        {state.statusDetail !== null && (
          <p className={state.activity === "needsAction" ? "agent-needs" : "agent-note"}>
            {state.statusDetail}
          </p>
        )}
        {!running && (
          <p className="agent-exited">
            {label} exited{exitCode === 0 ? "" : ` with code ${exitCode}`}. Its output above is the
            record of why.
          </p>
        )}
        <div ref={tailRef} />
      </div>

      <div className="composer">
        {attachments.length > 0 && (
          <ul className="chips">
            {attachments.map((path) => (
              <li key={path} className="chip">
                <span className="chip-name" title={path}>
                  {path.split(/[/\\]/).pop()}
                </span>
                <button
                  className="chip-remove"
                  type="button"
                  aria-label={`Remove ${path}`}
                  onClick={() => setAttachments((current) => current.filter((item) => item !== path))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {suggestions.length > 0 && (
          <ul className="suggestions">
            {suggestions.map((name) => (
              <li key={name}>
                <button type="button" onClick={() => setDraft(`/${name} `)}>
                  /{name}
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          ref={composerRef}
          className="composer-input"
          value={draft}
          rows={3}
          spellCheck={false}
          disabled={!running}
          placeholder={running ? `Ask ${label}. Enter sends, Shift+Enter is a newline.` : "Session ended."}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />

        <div className="composer-actions">
          <button className="composer-attach" type="button" onClick={() => void attach()} disabled={!running}>
            + Attach
          </button>
          {state.activity === "working" && running && (
            <button
              className="composer-stop"
              type="button"
              onClick={() => idRef.current !== null && window.oikist.session.interrupt(idRef.current)}
            >
              Stop
            </button>
          )}
          <button className="composer-send" type="button" onClick={send} disabled={!running}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One turn.
 *
 * Fenced code blocks are split out so build output and diffs keep their shape; the rest
 * is rendered as preformatted text. Deliberately not a markdown library — a dependency
 * is a decision-record entry, and this covers what an agent transcript actually contains.
 */
function Turn({
  turn,
  label
}: {
  readonly turn: SessionTurn;
  readonly label: string;
}): React.JSX.Element {
  const segments = useMemo(() => splitFences(turn.text), [turn.text]);
  return (
    <article className={`turn turn--${turn.role}`}>
      <span className="turn-role">{turn.role === "user" ? "You" : label}</span>
      <div className="turn-body">
        {segments.map((segment, index) =>
          segment.code ? (
            <pre key={index} className="turn-code">
              <code>{segment.text}</code>
            </pre>
          ) : (
            <p key={index} className="turn-text">
              {segment.text}
            </p>
          )
        )}
        {turn.tools.length > 0 && (
          <ul className="turn-tools">
            {turn.tools.map((tool, index) => (
              <li key={index}>{tool}</li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

interface Segment {
  readonly text: string;
  readonly code: boolean;
}

export function splitFences(text: string): readonly Segment[] {
  const parts = text.split(/```[^\n]*\n?/);
  return parts
    .map((part, index) => ({ text: index % 2 === 0 ? part.trim() : part.replace(/\n$/, ""), code: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}
