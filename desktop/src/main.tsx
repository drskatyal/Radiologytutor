import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./toast";
import App from "./App";
import { initProtocol, invoke, isTauri } from "./platform";
import "./styles.css";

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
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>
);
