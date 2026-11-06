import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./toast";
import App from "./App";
import { initProtocol, invoke, isTauri } from "./platform";
import appCss from "./styles.css?inline";
import { watchLongTasks } from "./perfWatch";
import { installContextMenuGuard } from "./contextMenuGuard";

// Benchmark: when did our JS start, relative to process start?
if (isTauri) {
  void invoke<number>("startup_elapsed_ms").then((ms) => {
    (window as unknown as { __jsStartMs?: number }).__jsStartMs = ms;
  });
}

// Windows / macOS: Rust painted this same splash natively the moment the
// window appeared, before the webview was up (src-tauri/src/splash.rs). The
// page's own copy (index.html `.boot`) has painted by the second frame from
// here; a little later it has reached the screen too, and the native one can
// go. Elsewhere (no native splash) the call does nothing.
if (isTauri) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.setTimeout(() => void invoke("splash_done").catch(() => undefined), 32))
  );
}

// The dicom:// base differs per OS (Windows maps custom schemes to http://<scheme>.localhost).
// Resolved in parallel with the first render: nothing on the start screen
// needs it, and opening a study awaits it (`protocolReady`).
void initProtocol();
watchLongTasks();
// No browser menu (Back / Refresh / Print) anywhere but text fields.
installContextMenuGuard();
// Phase 2 spike (FLOWRAD_NATIVE=1 + FLOWRAD_BENCH_VIEW=native-spike): the
// native-renderer test view instead of the app. Asked after the first render,
// so a normal start never waits on it.
const NativeSpike = lazy(() => import("./native/NativeSpike"));
function Root() {
  const [spike, setSpike] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    void Promise.all([
      invoke<{ enabled: boolean }>("native_status").catch(() => null),
      invoke<string | null>("bench_view").catch(() => null),
    ]).then(([native, view]) => setSpike(!!native?.enabled && view === "native-spike"));
  }, []);
  if (spike) {
    return (
      <Suspense fallback={null}>
        <NativeSpike />
      </Suspense>
    );
  }
  return <App />;
}

// The app stylesheet ships inside this script (`?inline`) and is applied
// before React renders: the page requests no stylesheet while it loads. A
// stylesheet still loading held WebKit's first paint of the splash, even as
// `media="print"` (CI macOS: the first paint came ~20 ms sooner after the
// document was parsed once it was gone).
const appStyle = document.createElement("style");
appStyle.setAttribute("data-app-css", "");
appStyle.textContent = appCss;
document.head.appendChild(appStyle);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>
);
