import "@fontsource-variable/inter";
import "@fontsource-variable/caveat";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DesignPage } from "./DesignPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesignPage />
  </StrictMode>,
);
