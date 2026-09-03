import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  IPC,
  type OikistBridge,
  type PtyCreateOptions,
  type PtyDataMessage,
  type PtyExitMessage,
  type RuntimeInfo
} from "../shared/ipc.js";

/**
 * Subscribes to a main-to-renderer channel and returns an unsubscribe function.
 *
 * The raw `IpcRendererEvent` is deliberately not passed through: it carries `sender`,
 * which would hand the renderer a way to reach back into the IPC machinery. Listeners
 * receive only the payload.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * The entire surface the renderer is given.
 *
 * Each method wraps one named channel and nothing else — no generic `invoke(channel)`
 * escape hatch, because that would hand the renderer the whole main process through a
 * string. Adding a capability means adding it here deliberately.
 */
const bridge: OikistBridge = {
  runtimeInfo: () => ipcRenderer.invoke(IPC.runtimeInfo) as Promise<RuntimeInfo>,
  pty: {
    create: (options: PtyCreateOptions) => ipcRenderer.invoke(IPC.ptyCreate, options) as Promise<string>,
    write: (id, data) => ipcRenderer.send(IPC.ptyWrite, { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, { id, cols, rows }),
    dispose: (id) => ipcRenderer.send(IPC.ptyDispose, { id }),
    onData: (listener) => subscribe<PtyDataMessage>(IPC.ptyData, listener),
    onExit: (listener) => subscribe<PtyExitMessage>(IPC.ptyExit, listener)
  },
  layout: {
    load: () => ipcRenderer.invoke(IPC.layoutLoad) as Promise<unknown>,
    save: (layout: unknown) => ipcRenderer.send(IPC.layoutSave, layout)
  }
};

contextBridge.exposeInMainWorld("oikist", bridge);
