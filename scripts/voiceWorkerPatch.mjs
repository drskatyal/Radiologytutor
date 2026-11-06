// The checked patches that turn vosk-browser's embedded recognizer worker into
// FlowRad's recognizer-worker.js (scripts/build-voice-worker.mjs; tested in
// lib/voiceWorkerBuild.test.ts). Each patch must match exactly once, or the
// build fails — a vosk-browser upgrade is noticed, never silently half-patched.
//
//   1. download progress is posted to the page ({event:"progress"}), so the
//      UI shows a real progress bar instead of a spinner;
//   2–3. no IndexedDB persistence (IDBFS): the model is extracted into memory.
//      Persisting it doubled the storage, failed outright where IndexedDB is
//      small or absent ("Failed to sync file system"), and the archive is
//      local (desktop) or HTTP-cached (web) anyway;
//   4. defence in depth: embind's createNamedFunction builds `new Function`
//      only to name generated wrappers. A plain closure named with
//      defineProperty does the same, so the worker holds no dynamic code at
//      all and would run even under a CSP without 'unsafe-eval';
//   5. errors that are not Error objects (Emscripten rejects with strings)
//      still reach the page with their text.

const WORKER_BASE64 = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/;

export const EVAL_NAMED_FUNCTION =
  'function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\\n"+\'    "use strict";\'+"    return body.apply(this, arguments);\\n"+"};\\n")(body)}';

export const SAFE_NAMED_FUNCTION =
  'function createNamedFunction(name,body){name=makeLegalFunctionName(name);var f=function(){"use strict";return body.apply(this,arguments)};try{Object.defineProperty(f,"name",{value:name})}catch(e){}return f}';

export const PATCHES = [
  [
    "bytesWritten=bytesWritten+value.length;",
    'bytesWritten=bytesWritten+value.length;self.postMessage({event:"progress",loaded:bytesWritten,total:length||0});',
  ],
  ["this.Vosk.FS.mount(this.Vosk.IDBFS, {}, storagePath);", "/* FlowRad: in-memory only, no IDBFS */"],
  ["return this.Vosk.syncFilesystem(true);", "return undefined;"],
  ["return this.Vosk.syncFilesystem(false);", "return undefined;"],
  [EVAL_NAMED_FUNCTION, SAFE_NAMED_FUNCTION],
  [
    'ctx.postMessage({ event: "error", error: error.message });',
    'ctx.postMessage({ event: "error", error: (error && error.message) || String(error) });',
  ],
];

/** Dynamic code (eval / new Function) left in a script, if any. */
export const DYNAMIC_CODE = /\bnew Function\b|[^.\w]eval\(/;

/** vosk-browser's dist/vosk.js → the patched worker source. Throws on any mismatch. */
export function patchVoiceWorker(bundle) {
  const match = bundle.match(WORKER_BASE64);
  if (!match) throw new Error("vosk-browser's embedded worker was not found (package changed?)");
  let source = Buffer.from(match[1], "base64").toString("utf8");
  for (const [from, to] of PATCHES) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw new Error(`expected one "${from.slice(0, 60)}", found ${count} (vosk-browser changed?)`);
    source = source.replace(from, to);
  }
  if (DYNAMIC_CODE.test(source)) throw new Error("the worker still contains dynamic code (new Function / eval)");
  return source;
}
