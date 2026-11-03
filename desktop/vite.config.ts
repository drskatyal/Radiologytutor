// FlowRad Viewer renderer. Built with Vite (not `next build`): the desktop
// bundle needs one static page, no server, and no Next runtime. It imports the
// SAME `lib/` and `components/ui` the web app ships, through the `@/` alias, so
// stack ordering, presets, cine and the design system stay identical.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import path from "node:path";


const root = path.resolve(__dirname, "..");

/**
 * List the viewer engine's chunks in the page so the app can preload them
 * (fetch + compile, NOT evaluate) at the right moment. The engine stays a dynamic import — nothing runs until a study
 * opens — but its ~3 MB no longer has to be fetched and compiled on the
 * critical path between the instant preview and the first real image.
 */
function preloadEngineChunks(): Plugin {
  const engine = /node_modules\/@cornerstonejs\/(core|tools|dicom-image-loader)\//;
  return {
    name: "flowrad-preload-engine",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const files = new Set<string>();
        const add = (file: string) => {
          if (files.has(file)) return;
          files.add(file);
          const chunk = bundle[file];
          if (chunk?.type === "chunk") chunk.imports.forEach(add);
        };
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === "chunk" && chunk.isDynamicEntry && chunk.facadeModuleId && engine.test(chunk.facadeModuleId)) add(chunk.fileName);
        }
        // A list, not <link rel=modulepreload> tags: preloading 3 MB at page
        // load competed with the instant preview on a cold disk (perf-windows
        // cold CT: preview 816 ms). The app starts the preload when it is
        // cheap (engine.ts preloadEngineChunks).
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: { name: "flowrad-engine-chunks", content: [...files].map((f) => `/${f}`).join(" ") },
              injectTo: "head" as const,
            },
          ],
        };
      },
    },
  };
}

/**
 * Old CommonJS globals shims (`new Function("return this")()`) ask for eval,
 * which the app's CSP (script-src without 'unsafe-eval') refuses: one guarded
 * shim in the bundle reached it on every start and logged a CSP violation.
 * `globalThis` is what they compute; swap it in.
 */
function noEvalGlobalShim(): Plugin {
  const shim = /(?:new )?Function\("return this"\)\(\)/g;
  return {
    name: "flowrad-no-eval-global-shim",
    apply: "build",
    renderChunk(code) {
      if (!code.includes('Function("return this")')) return null;
      return { code: code.replace(shim, "globalThis"), map: null };
    },
  };
}

/**
 * The app stylesheet off the first paint's critical path: the splash in
 * index.html is styled inline, but a stylesheet in <head> still holds the
 * first paint until it has loaded (WebKit: no paint while a head sheet is
 * pending). Loaded as `media="print"` (fetched, not render-blocking); main.tsx
 * waits for it and switches it on before React renders, so nothing ever
 * paints unstyled.
 */
function nonBlockingAppCss(): Plugin {
  return {
    name: "flowrad-non-blocking-css",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/<link rel="stylesheet"([^>]*?)>/g, (tag, attrs: string) =>
          attrs.includes("media=") ? tag : `<link rel="stylesheet"${attrs} media="print" data-app-css>`
        );
      },
    },
  };
}

export default defineConfig({
  root: __dirname,
  plugins: [react(), viteCommonjs(), preloadEngineChunks(), noEvalGlobalShim(), nonBlockingAppCss()],
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^@flowrad\/viewer-core$/, replacement: `${root}/packages/viewer-core/src/index.ts` },
      { find: /^@flowrad\/viewer-core\/(.*)$/, replacement: `${root}/packages/viewer-core/src/$1` },
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
