import { StrictMode, Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./toast";
import App from "./App";
import { initProtocol, invoke, isTauri } from "./platform";
import "./styles.css";
import { watchLongTasks } from "./perfWatch";
import { installContextMenuGuard } from "./contextMenuGuard";

// Benchmark: when did our JS start, relative to process start?
if (isTauri) {
  void invoke<number>("startup_elapsed_ms").then((ms) => {
    (window as unknown as { __jsStartMs?: number }).__jsStartMs = ms;
  });
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
    </ToastProvider>
  </StrictMode>
);
