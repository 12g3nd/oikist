import { useEffect, useState } from "react";

import type { RuntimeInfo } from "../../shared/ipc.js";
import { TerminalPane } from "./Terminal.js";

/**
 * The M2 shell.
 *
 * Deliberately not a placeholder screen: it renders the one thing M2 exists to prove,
 * which is that the main process, the preload bridge and the renderer are actually
 * talking to each other. If the runtime panel below is populated, the chain works.
 */
export function App(): React.JSX.Element {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  useEffect(() => {
    // Guarded rather than assumed. If the preload fails to load, `window.oikist` is
    // undefined and calling through it throws inside the effect, React unmounts the
    // tree, and the window goes blank with the reason visible only in DevTools. A
    // missing bridge is a legitimate runtime state and has to render as one.
    const bridge = window.oikist as typeof window.oikist | undefined;
    if (bridge === undefined) {
      setBridgeError("window.oikist is undefined — the preload script did not load.");
      return;
    }
    bridge
      .runtimeInfo()
      .then(setRuntime)
      .catch((error: unknown) => {
        setBridgeError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  return (
    <div className="shell">
      <aside className="rail" aria-label="Agents">
        <span className="rail-label">AGENTS</span>
        <p className="rail-empty">
          No agents yet. The rail becomes the spine of the app at M4.
        </p>
      </aside>

      <main className="main">
        <header className="head">
          <h1>oikist</h1>
          <p className="tagline">An agent-native development environment for Windows.</p>
        </header>

        <section className="panel">
          <h2>Runtime</h2>
          {bridgeError !== null && (
            <p className="error" role="alert">
              The preload bridge did not answer: {bridgeError}
            </p>
          )}
          {bridgeError === null && runtime === null && <p className="dim">Asking the main process…</p>}
          {runtime !== null && (
            <dl className="kv">
              <dt>app</dt>
              <dd>{runtime.app}</dd>
              <dt>electron</dt>
              <dd>{runtime.electron}</dd>
              <dt>chrome</dt>
              <dd>{runtime.chrome}</dd>
              <dt>node</dt>
              <dd>{runtime.node}</dd>
              <dt>platform</dt>
              <dd>{runtime.platform}</dd>
            </dl>
          )}
        </section>

        <section className="panel panel--term">
          <h2>Terminal</h2>
          <TerminalPane focused />
        </section>
      </main>
    </div>
  );
}
