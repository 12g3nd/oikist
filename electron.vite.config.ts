import { resolve } from "node:path";

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "electron-vite";

// Matches the Chromium and Node versions Electron 41 ships, so nothing is transpiled
// further down than the runtime actually needs.
const CHROME = "chrome140";
const NODE = "node22";

export default defineConfig({
  main: {
    build: {
      target: NODE,
      rollupOptions: { input: { index: resolve("src/main/index.ts") } }
    }
  },
  preload: {
    build: {
      target: NODE,
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        // A sandboxed preload is evaluated as CommonJS and cannot use `import`. This
        // package is "type": "module", so without an explicit format the preload emits
        // as ESM and fails to load with "Cannot use import statement outside a module",
        // leaving `window.oikist` undefined and the window blank.
        output: { format: "cjs", entryFileNames: "[name].cjs" }
      }
    }
  },
  renderer: {
    root: "src/renderer",
    build: {
      target: CHROME,
      rollupOptions: { input: { index: resolve("src/renderer/index.html") } }
    },
    resolve: {
      alias: { "@": resolve("src/renderer/src") }
    },
    plugins: [react()]
  }
});
