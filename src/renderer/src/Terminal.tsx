import { useEffect, useRef, useState } from "react";

import { describeAgentExit, type AgentExit } from "../../shared/agents.js";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as Xterm } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";

const THEME = {
  background: "#0f1211",
  foreground: "#d5ddd8",
  cursor: "#4fc7be",
  cursorAccent: "#0f1211",
  selectionBackground: "#25423f",
  black: "#0f1211",
  red: "#e0736a",
  green: "#7fc98b",
  yellow: "#d9b166",
  blue: "#6aa6d6",
  magenta: "#b98cd1",
  cyan: "#4fc7be",
  white: "#d5ddd8",
  brightBlack: "#7b8781"
};

interface TerminalPaneProps {
  /** Marks which pane owns keyboard focus; only the focused pane takes input. */
  readonly focused: boolean;
  /** Where the shell or agent starts. Absent means the home directory. */
  readonly cwd?: string;
  /** Absent for a plain shell; set to run a coding agent in this pane. */
  readonly agent?: "claude" | "codex";
  /** Resume this agent session rather than starting a new one. */
  readonly resumeSessionId?: string;
  /** Reports the agent session this pane ended up running, so it can be resumed later. */
  readonly onAgentSession?: (sessionId: string) => void;
  readonly onExit?: (exitCode: number) => void;
}

/**
 * One terminal pane: an xterm instance bound to one pty in the main process.
 *
 * The xterm instance is deliberately held in a ref rather than React state. It owns a
 * canvas and a WebGL context, and letting React's render cycle recreate it would
 * destroy and re-establish the GPU context on every parent update.
 */
export function TerminalPane({
  focused,
  cwd,
  agent,
  resumeSessionId,
  onAgentSession,
  onExit
}: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);

  // Held in a ref, never in the effect's dependencies.
  //
  // Callers pass an inline arrow, which is a new function on every render. As a
  // dependency it made the effect tear down and recreate the terminal — and its pty —
  // on every parent render, which spawned a second shell and left a duplicate agent in
  // the rail. The pane must be created exactly once per pane identity.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  // An agent pane never removes itself. A shell that exits was told to; an agent that
  // exits may have failed, and its last output is the error message — closing the pane
  // throws away the only explanation the user is going to get.
  const [exited, setExited] = useState<AgentExit | null>(null);
  const [runKey, setRunKey] = useState(0);

  // A ref, and emphatically not a dependency. The pane reports its new session id
  // upward, which comes straight back down as this prop — so as a dependency it re-ran
  // the effect and relaunched the agent with `--resume <id>` for a session created
  // seconds earlier and never written to disk. Claude answered "No conversation found
  // with session ID", exited, and the pane closed itself. Read at run time, never
  // watched.
  const resumeRef = useRef(resumeSessionId);
  resumeRef.current = resumeSessionId;
  const onAgentSessionRef = useRef(onAgentSession);
  onAgentSessionRef.current = onAgentSession;

  // A ref for the same reason: a running shell cannot be moved to another directory, so
  // this is only read when the pty is created. Watching it would restart the pane.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    const term = new Xterm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: THEME
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // WebGL is the reason a terminal keeps up with build output, but it is not
    // guaranteed: a machine without a usable GPU context falls back to the DOM renderer
    // rather than failing to open a terminal at all.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }

    fit.fit();

    let disposed = false;
    let ptyId: string | null = null;
    const pending: string[] = [];

    const offData = window.oikist.pty.onData(({ id, chunk }) => {
      if (id === ptyId) {
        term.write(chunk);
      }
    });
    const startedAt = performance.now();
    const offExit = window.oikist.pty.onExit(({ id, exitCode }) => {
      if (id !== ptyId) {
        return;
      }
      if (agent === undefined) {
        onExitRef.current?.(exitCode);
        return;
      }
      setExited(describeAgentExit(exitCode, performance.now() - startedAt));
    });

    const resume = resumeRef.current;
    const where = cwdRef.current;
    const start = {
      cols: term.cols,
      rows: term.rows,
      ...(where === undefined || where === "" ? {} : { cwd: where })
    };
    const request = agent === undefined
      ? start
      : {
          ...start,
          agent,
          ...(resume === undefined ? {} : { resumeSessionId: resume })
        };
    void window.oikist.pty.create(request).then((created) => {
      if (disposed) {
        // The pane unmounted while the shell was starting; do not leave it running.
        window.oikist.pty.dispose(created.id);
        return;
      }
      ptyId = created.id;
      if (created.agentSessionId !== undefined) {
        onAgentSessionRef.current?.(created.agentSessionId);
      }
      // Keystrokes typed before the shell existed are replayed rather than dropped.
      for (const queued of pending) {
        window.oikist.pty.write(created.id, queued);
      }
      pending.length = 0;
    }).catch((error: unknown) => {
      // A pane that cannot start says so in the pane. The alternative is an empty black
      // rectangle and an error only visible in a log the user will never open.
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, "") : String(error);
      term.write(`

[31m${message}[0m

`);
    });

    const onKey = term.onData((data) => {
      if (ptyId === null) {
        pending.push(data);
      } else {
        window.oikist.pty.write(ptyId, data);
      }
    });

    const observer = new ResizeObserver(() => {
      // A zero-sized host (a hidden tab) would fit to 0 columns and corrupt the shell's
      // idea of the viewport, so resizes are only forwarded when the pane has area.
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        return;
      }
      fit.fit();
      if (ptyId !== null) {
        window.oikist.pty.resize(ptyId, term.cols, term.rows);
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      offData();
      offExit();
      onKey.dispose();
      if (ptyId !== null) {
        window.oikist.pty.dispose(ptyId);
      }
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [agent, runKey]);

  useEffect(() => {
    if (focused) {
      termRef.current?.focus();
    }
  }, [focused]);

  return (
    <div className="term-wrap">
      {exited !== null && (
        <div className={`term-exit${exited.failed ? " term-exit--failed" : ""}`} role="status">
          <span className="term-exit-message">{exited.message}</span>
          <button
            type="button"
            className="term-exit-action"
            onClick={() => {
              setExited(null);
              // Bumping the key re-runs the effect, which builds a fresh terminal and a
              // fresh pty. The previous output stays on screen until it does.
              setRunKey((key) => key + 1);
            }}
          >
            START AGAIN
          </button>
        </div>
      )}
      <div className="term-host" ref={hostRef} />
    </div>
  );
}
