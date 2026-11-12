// Compile the dependency-free C2 schema for Node preloading in the minimal
// standalone image. No environment values are read or embedded during build.
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @param {string} outputDir */
export function buildRuntimeEnv(outputDir = path.join(root, ".next/standalone/runtime")) {
  const source = readFileSync(path.join(root, "lib/envSchema.ts"), "utf8");
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "envSchema.cjs"), result.outputText);
  const entry = path.join(outputDir, "startup-check.cjs");
  copyFileSync(path.join(root, "scripts/startup-check.cjs"), entry);
  return entry;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRuntimeEnv();
  console.log("Built production environment check (names only; no runtime values).");
}
