import { writeFile } from "node:fs/promises";

import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";

import { IPC, type RuntimeInfo } from "../shared/ipc.js";
import { resolveRendererPath } from "../shared/renderer-path.js";

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
    // One frame of settle time, so async first paints (fonts, the runtime panel's IPC
    // round trip) are in the image rather than caught mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const image = await window.webContents.capturePage();
    await writeFile(target, image.toPNG());
    console.log(`captured ${target}`);
  } catch (error) {
    console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
  app.quit();
}

/**
 * oikist is a single-user desktop application, but the renderer is still treated as
 * untrusted: context isolation on, node integration off, sandbox on. Everything the
 * renderer can do reaches the OS through an explicitly listed IPC channel, never
 * through an ambient Node global.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
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
    window.show();
    void captureIfRequested(window);
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

void app.whenReady().then(() => {
  serveRenderer(fileURLToPath(new URL("../renderer/", import.meta.url)));
  createWindow();

  // macOS convention, harmless on Windows. Kept so the app behaves correctly if it is
  // ever run elsewhere, without pretending macOS is supported.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
