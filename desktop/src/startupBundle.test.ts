// What the start screen's bundle may pull in. Run: npm --prefix desktop test
//
// Toasts are Radix Toast + framer-motion, about a fifth of the entry script, and the
// start screen never shows one: `src/toast.tsx` loads the real component lazily.
// A single static import of the `@/components/ui` barrel anywhere on the startup path
// (it re-exports Toast) silently puts it back in the entry chunk. That happened via
// components/viewer/voice/VoiceStatus.tsx: 650 kB → 507 kB once it was fixed. This walks
// the static import graph from main.tsx (dynamic `import()` and `import type` excluded,
// as Vite does) and fails if it reaches any of them. Tooltip (Radix + floating-ui) is
// only used by the series panel frame, which loads with the study view (App.tsx).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopSrc = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopSrc, "../..");
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(repoRoot, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package: not ours to walk
  for (const ext of EXTS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** Static, value-level specifiers of a module (no `import()`, no `import type` / `export type`). */
function staticSpecs(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const m of source.matchAll(re)) if (!m[2]) out.push(m[3]);
  return out;
}

function startupGraph(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.(ts|tsx)$/.test(file)) continue;
    for (const spec of staticSpecs(readFileSync(file, "utf8"))) {
      const dep = resolveSpec(spec, file);
      if (dep && !seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return seen;
}

test("startup bundle: the shared UI barrel, Toast and Tooltip stay out of the entry", () => {
  const graph = startupGraph(path.join(desktopSrc, "main.tsx"));
  assert.ok(graph.has(path.join(desktopSrc, "App.tsx")), "the walk reaches App.tsx (sanity)");
  const rel = (p: string) => path.relative(repoRoot, p);
  for (const banned of ["components/ui/index.ts", "components/ui/Toast.tsx", "components/ui/Tooltip.tsx"]) {
    assert.ok(!graph.has(path.join(repoRoot, banned)), `${banned} is statically reachable from main.tsx: import a primitive's own file (e.g. "@/components/ui/Button"), never the "@/components/ui" barrel, and load anything that needs Toast or Tooltip lazily (src/toast.tsx, preloadable() in App.tsx)`);
  }
  // Sanity: the lazy toast shim itself is on the path, and it only reaches Toast via import().
  assert.ok([...graph].some((p) => rel(p) === "desktop/src/toast.tsx"), "src/toast.tsx is on the startup path");
});
