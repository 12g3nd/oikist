import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import { IPC, type PtyCreateOptions, type PtyCreated, type RuntimeInfo } from "../shared/ipc.js";
import { resolveRendererPath } from "../shared/renderer-path.js";
import { mergeAgents } from "../shared/agents.js";
import { AgentDiscovery } from "./agents/discovery.js";
import { startHookServer, type HookServer } from "./agents/hook-server.js";
import { AgentLauncher } from "./agents/launcher.js";
import { LayoutStore, type WindowBounds } from "./layout-store.js";
import { readWorkingState } from "./agents/git.js";
import { claudeLimits, readCodexLimits } from "./agents/limits.js";
import { listDirectory, readTextFile } from "./files.js";
import { PtyManager } from "./pty.js";

/**
 * The renderer is served over `app://` rather than loaded from `file://`.
 *
 * A `file://` page has an opaque origin, so `script-src 'self'` in the renderer's CSP
 * matches nothing and every module script is blocked — the page renders as a blank
 * window with no visible error. A registered standard scheme gives the renderer a real,
 * stable origin, so the strict CSP actually applies instead of silently failing.
 */
const APP_SCHEME = "app";
const RENDERER_ORIGIN = `${APP_SCHEME}://oikist`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true }
  }
]);

/** Serves the built renderer, refusing any path that escapes its directory. */
function serveRenderer(rendererDir: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    const resolved = resolveRendererPath(rendererDir, new URL(request.url).pathname);
    if (resolved === null) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

/**
 * Writes a PNG of the window's own contents when `OIKIST_CAPTURE` names a path, then
 * quits.
 *
 * The UI half of this project is verified by looking at it rather than by automated
 * tests, so that verification needs a repeatable way to see the window. This captures
 * through Electron, which photographs only what the application itself painted — a
 * desktop screenshot would also capture whatever else happened to be on screen.
 */
async function captureIfRequested(window: BrowserWindow): Promise<void> {
  const target = process.env.OIKIST_CAPTURE;
  if (target === undefined || target === "") {
    return;
  }
  try {
    // Settle time before the shutter. 700ms covers a first paint; verifying something
    // that has to boot first — an agent starting in a pane — needs longer, so the delay
    // is adjustable rather than a constant that quietly photographs the wrong moment.
    const settleMs = Number(process.env.OIKIST_CAPTURE_DELAY ?? "700");
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(settleMs) ? settleMs : 700));

    // Optionally drive the UI before the shutter. Verifying a view that only appears
    // after a click otherwise means photographing the state before the interesting part
    // happens, which is how the terminal pane got declared working while blank.
    const clickSelector = process.env.OIKIST_CLICK;
    if (clickSelector !== undefined && clickSelector !== "") {
      const clicked: unknown = await window.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (el instanceof HTMLElement) { el.click(); return true; } return false; })()`
      );
      console.log(`[click] ${clickSelector} -> ${clicked === true ? "clicked" : "NO MATCH"}`);
      // Separate from the pre-click delay: what the click starts may take far longer to
      // become visible than the page took to render in the first place — an agent
      // booting, for instance.
      const clickSettle = Number(process.env.OIKIST_CLICK_SETTLE ?? "900");
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(clickSettle) ? clickSettle : 900));
    }
    const image = await window.webContents.capturePage();
    await writeFile(target, image.toPNG());
    console.log(`captured ${target}`);
  } catch (error) {
    console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
    shutdown(1);
    return;
  }
  shutdown(0);
}

/**
 * One PtyManager per window, so closing a window kills exactly its own shells and no
 * others. Keyed by WebContents id because that is what every IPC event carries.
 */
const ptyManagers = new Map<number, PtyManager>();

/** Created once app paths are available, so `app.getPath` has a real answer. */
let layoutStore: LayoutStore | null = null;

/**
 * Remembers where the window was.
 *
 * Read from the *normal* bounds rather than the current ones, so a maximized window
 * restores to a sensible size when it is later unmaximized instead of to the full
 * screen it happened to occupy at quit.
 */
function rememberBounds(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized()) {
    return;
  }
  const { width, height, x, y } = window.getNormalBounds();
  const bounds: WindowBounds = { width, height, x, y, maximized: window.isMaximized() };
  layoutStore?.setWindow(bounds);
}

function managerFor(event: IpcMainEvent | IpcMainInvokeEvent): PtyManager | undefined {
  return ptyManagers.get(event.sender.id);
}

/**
 * oikist is a single-user desktop application, but the renderer is still treated as
 * untrusted: context isolation on, node integration off, sandbox on. Everything the
 * renderer can do reaches the OS through an explicitly listed IPC channel, never
 * through an ambient Node global.
 */
function createWindow(stored?: WindowBounds): BrowserWindow {
  const window = new BrowserWindow({
    width: stored?.width ?? 1280,
    height: stored?.height ?? 820,
    ...(stored?.x !== undefined && stored.y !== undefined ? { x: stored.x, y: stored.y } : {}),
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: "#0f1211",
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Shown only once the first frame is painted, so startup never flashes an empty
  // white window before the shell renders.
  window.once("ready-to-show", () => {
    if (stored?.maximized === true) {
      window.maximize();
    }
    window.show();
    void captureIfRequested(window);
    // Regression guard for the shutdown defect below: closes the window on the normal
    // user path so a headless run can assert the app actually exits.
    const closeAfter = Number(process.env.OIKIST_CLOSE_TEST ?? "0");
    if (closeAfter > 0) {
      setTimeout(() => window.close(), closeAfter);
    }
  });

  // Nothing in this application navigates itself to an external site, and a window that
  // did would be a bug rather than a feature. External links open in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Renderer diagnostics on the main process's stdout. A renderer that fails to boot
  // otherwise presents as a blank window with the failure only visible in DevTools,
  // which is useless when the app is being driven headlessly.
  window.webContents.on("console-message", (...args: unknown[]) => {
    console.log("[renderer]", JSON.stringify(args.slice(1)).slice(0, 600));
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[did-fail-load] ${code} ${description} ${url}`);
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload-error] ${preloadPath}: ${error.message}`);
  });

  // Wrapped rather than using forWebContents directly: an agent whose process ends is
  // no longer running, and the rail must stop saying it is. A crashed agent never sends
  // session-end, so the pty's own exit is the only reliable signal.
  const manager = new PtyManager((channel, payload) => {
    if (window.isDestroyed()) {
      return;
    }
    window.webContents.send(channel, payload);
    if (channel !== IPC.ptyExit) {
      return;
    }
    const ptyId = (payload as { id: string }).id;
    const sessionId = agentSessionForPty.get(ptyId);
    if (sessionId !== undefined) {
      agentSessionForPty.delete(ptyId);
      if (launcher?.forget(sessionId) === true) {
        publishAgents();
      }
    }
  });

  // Read once, here, and never inside `closed`.
  //
  // By the time `closed` fires the WebContents is destroyed, and touching
  // `window.webContents` there throws. That exception escaping the handler stopped
  // `window-all-closed` from firing, so `shutdown()` never ran and the app never
  // quit — it sat with four live processes indefinitely, on every quit path, whether
  // or not a terminal had ever been opened.
  const contentsId = window.webContents.id;
  ptyManagers.set(contentsId, manager);
  window.on("closed", () => {
    // Shells are killed with their window rather than left running headless.
    manager.disposeAll();
    ptyManagers.delete(contentsId);
  });

  // Debounced inside the store, so a drag writes once rather than once per frame.
  const remember = (): void => rememberBounds(window);
  window.on("resize", remember);
  window.on("move", remember);
  window.on("maximize", remember);
  window.on("unmaximize", remember);

  const devServer = process.env.ELECTRON_RENDERER_URL;
  void window.loadURL(devServer ?? `${RENDERER_ORIGIN}/index.html`);

  return window;
}

ipcMain.handle(IPC.runtimeInfo, (): RuntimeInfo => ({
  app: app.getVersion(),
  electron: process.versions.electron ?? "unknown",
  chrome: process.versions.chrome ?? "unknown",
  node: process.versions.node,
  platform: process.platform
}));

ipcMain.handle(IPC.ptyCreate, async (event, options: PtyCreateOptions): Promise<PtyCreated> => {
  const manager = managerFor(event);
  if (manager === undefined) {
    throw new Error("No terminal host for this window.");
  }
  if (options.agent !== "claude" || launcher === null) {
    return { id: await manager.create(options) };
  }

  const launch = await launcher.prepare(options.cwd, options.resumeSessionId);
  const id = await manager.create(options, { file: launch.file, args: launch.args });
  agentSessionForPty.set(id, launch.sessionId);
  // The pane appears in the rail immediately, before its first hook, so launching an
  // agent has visible effect rather than a second of nothing.
  publishAgents();
  return { id, agentSessionId: launch.sessionId };
});

ipcMain.on(IPC.ptyWrite, (event, { id, data }: { id: string; data: string }) => {
  managerFor(event)?.write(id, data);
});

ipcMain.on(IPC.ptyResize, (event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
  managerFor(event)?.resize(id, cols, rows);
});

/** Which pty runs which agent session, so closing a pane retires its rail row. */
const agentSessionForPty = new Map<string, string>();

ipcMain.on(IPC.ptyDispose, (event, { id }: { id: string }) => {
  managerFor(event)?.dispose(id);
  const sessionId = agentSessionForPty.get(id);
  if (sessionId !== undefined) {
    agentSessionForPty.delete(id);
    if (launcher?.forget(sessionId) === true) {
      publishAgents();
    }
  }
});

/**
 * One discovery loop for the whole app, broadcast to every window.
 *
 * Polling costs a process spawn per pass, so it is shared rather than run per window.
 */
let hookServer: HookServer | null = null;
let launcher: AgentLauncher | null = null;

/**
 * What the rail shows: agents oikist launched, merged over agents it found.
 *
 * A launched agent's own hooks beat anything the poller can infer about the same
 * session, so it wins the merge while discovery still contributes the pid and name.
 */
function snapshot(): {
  agents: ReturnType<typeof mergeAgents>;
  ok: boolean;
  error?: string;
  refreshedAt: string;
} {
  const found = discovery.last;
  return {
    agents: mergeAgents(launcher?.agents ?? [], found.agents),
    ok: found.ok,
    ...(found.error === undefined ? {} : { error: found.error }),
    refreshedAt: found.refreshedAt
  };
}

function publishAgents(): void {
  const payload = snapshot();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.agentsUpdated, payload);
    }
  }
}

const discovery = new AgentDiscovery({ onResult: () => publishAgents() });

ipcMain.handle(IPC.agentsList, () => snapshot());

ipcMain.handle(IPC.handoffState, (_event, cwd: string) => readWorkingState(cwd));

// The clipboard is the only thing a handoff writes to. Delivering it into an agent is
// the user's move, deliberately: pasting is where they get to read it first.
ipcMain.handle(IPC.handoffCopy, (_event, text: string) => {
  clipboard.writeText(typeof text === "string" ? text : "");
});

ipcMain.handle(IPC.providerLimits, async () => [claudeLimits(), await readCodexLimits()]);

// The viewer is read-only: there is no write, rename, or delete channel to reach for.
ipcMain.handle(IPC.filesHome, () => app.getPath("home"));
ipcMain.handle(IPC.filesList, (_event, path: string) => listDirectory(path));
ipcMain.handle(IPC.filesRead, (_event, path: string) => readTextFile(path));

// Choosing a project is the one place the app needs a path it was not given. The picker
// is the OS's own, so no directory listing crosses the bridge and a dismissed dialog is
// a null rather than an error.
ipcMain.handle(IPC.filesChoose, async (event, startIn: unknown): Promise<string | null> => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Open project",
    properties: ["openDirectory" as const],
    ...(typeof startIn === "string" && startIn !== "" ? { defaultPath: startIn } : {})
  };
  // Attached to its window when there is one, so the dialog is modal to the app rather
  // than a free-floating window that can be lost behind it.
  const result = window === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(window, options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle(IPC.layoutLoad, async (): Promise<unknown> => (await layoutStore?.load())?.layout);

ipcMain.on(IPC.layoutSave, (_event, layout: unknown) => {
  layoutStore?.setLayout(layout);
});

void app.whenReady().then(async () => {
  serveRenderer(fileURLToPath(new URL("../renderer/", import.meta.url)));
  hookServer = await startHookServer((event) => {
    if (launcher?.applyHookEvent(event) === true) {
      publishAgents();
    }
  });
  launcher = new AgentLauncher(hookServer.endpoint, hookServer.token);
  void AgentLauncher.sweepStaleSettings().then((removed) => {
    if (removed > 0) {
      console.log(`swept ${removed} stale hook settings directories`);
    }
  });
  layoutStore = LayoutStore.in(app.getPath("userData"));
  const stored = await layoutStore.load();
  createWindow(stored.window);
  discovery.start();

  // macOS convention, harmless on Windows. Kept so the app behaves correctly if it is
  // ever run elsewhere, without pretending macOS is supported.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/** Kills every shell, then quits. */
function shutdown(code = 0): void {
  discovery.stop();
  void hookServer?.close();
  void launcher?.dispose();
  for (const manager of ptyManagers.values()) {
    manager.disposeAll();
  }
  ptyManagers.clear();
  void code;
  app.quit();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    shutdown();
  }
});
