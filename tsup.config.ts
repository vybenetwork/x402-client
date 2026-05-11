import { defineConfig } from "tsup";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Three builds:
//   - dist/index.js    ESM for Node + bundlers
//   - dist/index.cjs   CommonJS for legacy Node
//   - dist/index.browser.js  ESM with `ws` swapped for native WebSocket
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: false,
    target: "node20",
    platform: "node",
  },
  {
    entry: { "index.browser": "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: false,
    target: "es2022",
    platform: "browser",
    // tsup externalizes deps by default; force-bundle "ws" so the alias
    // below kicks in and the browser build doesn't carry a bare `ws` import
    // (which would fail at runtime in the browser).
    noExternal: ["ws"],
    // Browser uses native WebSocket; alias the `ws` package to an adapter
    // that exposes the `.on(event, cb)` API the SDK code uses on top of
    // the platform's EventTarget-based WebSocket. esbuild needs an
    // absolute path here — relative paths get treated as bare imports.
    esbuildOptions(options) {
      options.alias = {
        ...(options.alias ?? {}),
        ws: path.join(__dirname, "src/internal/ws-browser.ts"),
      };
    },
  },
]);
