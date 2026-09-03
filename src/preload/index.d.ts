import type { OikistBridge } from "../shared/ipc.js";

declare global {
  interface Window {
    readonly oikist: OikistBridge;
  }
}

export {};
