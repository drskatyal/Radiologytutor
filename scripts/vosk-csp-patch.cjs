// Make vosk-browser's recognizer worker run under a Content-Security-Policy
// without 'unsafe-eval' (the desktop app: script-src 'self' 'wasm-unsafe-eval').
//
// vosk-browser 0.0.8 ships its worker as base64 inside dist/vosk.js and starts
// it from a blob: URL, which inherits the page's CSP. The worker's Emscripten
// embind glue makes one dynamic-code call: `createNamedFunction` builds
// `new Function(...)` only to give generated wrappers a readable name. Under
// that CSP it throws EvalError inside the worker, the model never reports
// "load", and the mic spun forever (FlowRad Viewer 0.8.0 on Windows).
//
// The replacement returns the same wrapper as a plain closure (constructible,
// same `this` and arguments forwarding) and sets its `name` with
// defineProperty, so nothing needs eval. Applied at build time by the web
// (next.config.mjs, webpack loader) and the desktop (vite.config.ts) builds.
// Throws if the source no longer matches, so a vosk-browser upgrade is
// noticed instead of silently reintroducing the eval.

const EVAL_NAMED_FUNCTION =
  'function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\\n"+\'    "use strict";\'+"    return body.apply(this, arguments);\\n"+"};\\n")(body)}';

const SAFE_NAMED_FUNCTION =
  'function createNamedFunction(name,body){name=makeLegalFunctionName(name);var f=function(){"use strict";return body.apply(this,arguments)};try{Object.defineProperty(f,"name",{value:name})}catch(e){}return f}';

const WORKER_BASE64 = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/;

/** Patch dist/vosk.js source. Returns the new source. */
function patchVoskSource(source) {
  const match = source.match(WORKER_BASE64);
  if (!match) throw new Error("vosk-csp-patch: worker base64 not found in vosk-browser (version changed?)");
  const worker = Buffer.from(match[1], "base64").toString("utf8");
  if (worker.includes(SAFE_NAMED_FUNCTION)) return source;
  const count = worker.split(EVAL_NAMED_FUNCTION).length - 1;
  if (count !== 1) {
    throw new Error(`vosk-csp-patch: expected one eval-based createNamedFunction in the worker, found ${count} (vosk-browser changed?)`);
  }
  const patched = worker.replace(EVAL_NAMED_FUNCTION, SAFE_NAMED_FUNCTION);
  if (/\bnew Function\b|[^.\w]eval\(/.test(patched)) {
    throw new Error("vosk-csp-patch: the worker still contains dynamic code after the patch");
  }
  const encoded = Buffer.from(patched, "utf8").toString("base64");
  return source.replace(match[0], `createBase64WorkerFactory('${encoded}'`);
}

/** Webpack loader entry (next.config.mjs). */
function loader(source) {
  return patchVoskSource(source);
}

module.exports = loader;
module.exports.patchVoskSource = patchVoskSource;
module.exports.EVAL_NAMED_FUNCTION = EVAL_NAMED_FUNCTION;
