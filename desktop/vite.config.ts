// FlowRad Viewer renderer. Built with Vite (not `next build`): the desktop
// bundle needs one static page, no server, and no Next runtime. It imports the
// SAME `lib/` and `components/ui` the web app ships, through the `@/` alias, so
// stack ordering, presets, cine and the design system stay identical.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

export default defineConfig({
  root: __dirname,
  plugins: [react(), viteCommonjs()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${root}/$1` },
      // components/ui/Breadcrumbs imports next/link; the desktop has no router.
      { find: "next/link", replacement: path.resolve(__dirname, "src/shims/next-link.tsx") },
    ],
    dedupe: ["react", "react-dom"],
  },
  // Cornerstone's loader ships its codecs as workers + WASM; pre-bundling
  // breaks their `new URL(..., import.meta.url)` resolution.
  optimizeDeps: {
    exclude: ["@cornerstonejs/dicom-image-loader"],
    include: ["dicom-parser"],
  },
  worker: { format: "es" },
  server: { port: 1420, strictPort: true, fs: { allow: [root] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: ["es2022", "chrome111", "safari16"],
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
    sourcemap: false,
  },
});
