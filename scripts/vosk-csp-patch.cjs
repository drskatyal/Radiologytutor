// Make vosk-browser's recognizer worker run under a Content-Security-Policy
// without 'unsafe-eval' (the desktop app: script-src 'self' 'wasm-unsafe-eval').
//
// vosk-browser 0.0.8 ships its worker as base64 inside dist/vosk.js and starts
// it from a blob: URL, which inherits the page's CSP. The worker's Emscripten
// embind glue builds code from strings in three places:
//   - `createNamedFunction`: `new Function(...)`, only to name wrappers;
//   - `craftInvokerFunction`: every C++ binding's call wrapper, via
//     `new_(Function, …)`;
//   - `__emval_get_method_caller`: JS method calls from C++, the same way.
// Under that CSP they throw EvalError inside the worker, the model never
// reports "load", and the mic spun forever (FlowRad Viewer 0.8.0 on Windows).
//
// Each is replaced by a plain closure doing the same steps (the form
// Emscripten itself emits with DYNAMIC_EXECUTION=0), so nothing needs eval. Applied at build time by the web
// (next.config.mjs, webpack loader) and the desktop (vite.config.ts) builds.
// Throws if the source no longer matches, so a vosk-browser upgrade is
// noticed instead of silently reintroducing the eval.

const EVAL_NAMED_FUNCTION =
  'function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\\n"+\'    "use strict";\'+"    return body.apply(this, arguments);\\n"+"};\\n")(body)}';

const SAFE_NAMED_FUNCTION =
  'function createNamedFunction(name,body){name=makeLegalFunctionName(name);var f=function(){"use strict";return body.apply(this,arguments)};try{Object.defineProperty(f,"name",{value:name})}catch(e){}return f}';

// embind's call wrappers: built from source text with new_(Function, …).
// Replaced by closures doing the same steps (Emscripten's own non-eval form,
// DYNAMIC_EXECUTION=0): wire the arguments, call, run destructors, unwire.
const CRAFT_INVOKER_START = "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){";
const CRAFT_INVOKER_END = "var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}";
const SAFE_CRAFT_INVOKER =
  'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expected=argCount-2;var first=isClassMethodFunc?2:1;var f=function(){if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!")}var destructors=needsDestructorStack?[]:null;var wired=[cppTargetFunc];var thisWired;if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired)}for(var i=0;i<expected;++i){wired.push(argTypes[i+2].toWireType(destructors,arguments[i]))}var rv=cppInvokerFunc.apply(null,wired);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(i===1?thisWired:wired[first+i-2])}}}if(returns){return argTypes[0].fromWireType(rv)}};try{Object.defineProperty(f,"name",{value:makeLegalFunctionName(humanName)})}catch(e){}return f}';

// emval method callers: same story.
const METHOD_CALLER_START = "function __emval_get_method_caller(argCount,argTypes){";
const METHOD_CALLER_END = "var invokerFunction=new_(Function,params).apply(null,args);return __emval_addMethodCaller(invokerFunction)}";
const SAFE_METHOD_CALLER =
  'function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var invokerFunction=function(handle,name,destructors,args){var offset=0;var a=new Array(argCount-1);for(var i=0;i<argCount-1;++i){a[i]=types[1+i].readValueFromPointer(args+offset);offset+=types[i+1]["argPackAdvance"]}var rv=handle[name].apply(handle,a);for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(a[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}};return __emval_addMethodCaller(invokerFunction)}';

/** Any way of turning a string into code, including embind's new_(Function, …). */
const DYNAMIC_CODE = /\bnew Function\b|new_\(Function\b|[^.\w$]eval\(|[^\w.$]Function\(/;

/** Replace the one function that starts with `start` and ends with `end`. */
function replaceFunction(source, start, end, replacement, what) {
  const at = source.indexOf(start);
  if (at < 0 || source.indexOf(start, at + 1) >= 0) {
    throw new Error(`vosk-csp-patch: expected one ${what} in the worker (vosk-browser changed?)`);
  }
  const stop = source.indexOf(end, at);
  if (stop < 0) throw new Error(`vosk-csp-patch: ${what} no longer ends as expected (vosk-browser changed?)`);
  return source.slice(0, at) + replacement + source.slice(stop + end.length);
}

const WORKER_BASE64 = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/;

/** Patch dist/vosk.js source. Returns the new source. */
function patchVoskSource(source) {
  const match = source.match(WORKER_BASE64);
  if (!match) throw new Error("vosk-csp-patch: worker base64 not found in vosk-browser (version changed?)");
  const worker = Buffer.from(match[1], "base64").toString("utf8");
  if (worker.includes(SAFE_NAMED_FUNCTION) && !DYNAMIC_CODE.test(worker)) return source;
  const count = worker.split(EVAL_NAMED_FUNCTION).length - 1;
  if (count !== 1) {
    throw new Error(`vosk-csp-patch: expected one eval-based createNamedFunction in the worker, found ${count} (vosk-browser changed?)`);
  }
  let patched = worker.replace(EVAL_NAMED_FUNCTION, SAFE_NAMED_FUNCTION);
  patched = replaceFunction(patched, CRAFT_INVOKER_START, CRAFT_INVOKER_END, SAFE_CRAFT_INVOKER, "craftInvokerFunction");
  patched = replaceFunction(patched, METHOD_CALLER_START, METHOD_CALLER_END, SAFE_METHOD_CALLER, "__emval_get_method_caller");
  const left = patched.match(DYNAMIC_CODE);
  if (left) {
    throw new Error(`vosk-csp-patch: the worker still contains dynamic code after the patch: …${patched.slice(Math.max(0, left.index - 60), left.index + 60)}…`);
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
