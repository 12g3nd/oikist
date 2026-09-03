import { useEffect, useRef } from "react";

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
  readonly onExit?: (exitCode: number) => void;
}

/**
 * One terminal pane: an xterm instance bound to one pty in the main process.
 *
 * The xterm instance is deliberately held in a ref rather than React state. It owns a
 * canvas and a WebGL context, and letting React's render cycle recreate it would
 * destroy and re-establish the GPU context on every parent update.
 */
export function TerminalPane({ focused, onExit }: TerminalPaneProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);

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
    const offExit = window.oikist.pty.onExit(({ id, exitCode }) => {
      if (id === ptyId) {
        onExit?.(exitCode);
      }
    });

    void window.oikist.pty.create({ cols: term.cols, rows: term.rows }).then((id) => {
      if (disposed) {
        // The pane unmounted while the shell was starting; do not leave it running.
        window.oikist.pty.dispose(id);
        return;
      }
      ptyId = id;
      // Keystrokes typed before the shell existed are replayed rather than dropped.
      for (const queued of pending) {
        window.oikist.pty.write(id, queued);
      }
      pending.length = 0;
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
  }, [onExit]);

  useEffect(() => {
    if (focused) {
      termRef.current?.focus();
    }
  }, [focused]);

  return <div className="term-host" ref={hostRef} />;
}
