import "@fontsource-variable/inter";
import "@fontsource-variable/caveat";
import "./app.css";
import { ToastProvider } from "@pdfreader/ui";
import { App } from "@pdfreader/viewer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { tauriEngine } from "./tauriEngine";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App engine={tauriEngine} />
    </ToastProvider>
  </StrictMode>,
);
