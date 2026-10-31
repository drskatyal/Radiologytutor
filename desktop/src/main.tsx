import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/ui/Toast";
import App from "./App";
import { initProtocol } from "./platform";
import "./styles.css";

// The dicom:// base differs per OS (Windows maps custom schemes to http://<scheme>.localhost).
void initProtocol().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StrictMode>
  );
});
