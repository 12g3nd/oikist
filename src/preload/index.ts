import { contextBridge, ipcRenderer } from "electron";

import { IPC, type OikistBridge, type RuntimeInfo } from "../shared/ipc.js";

/**
 * The entire surface the renderer is given.
 *
 * Each method wraps one named channel and nothing else — no generic `invoke(channel)`
 * escape hatch, because that would hand the renderer the whole main process through a
 * string. Adding a capability means adding it here deliberately.
 */
const bridge: OikistBridge = {
  runtimeInfo: () => ipcRenderer.invoke(IPC.runtimeInfo) as Promise<RuntimeInfo>
};

contextBridge.exposeInMainWorld("oikist", bridge);
