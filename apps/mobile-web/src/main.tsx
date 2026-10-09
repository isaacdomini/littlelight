import { setupIonicReact } from "@ionic/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Quiet motion: Ionic page transitions are skipped when the OS asks for reduced motion.
// The share viewer's URL carries the link token: no Referer, ever, from the first request on
// (nginx adds the header in production; Vite dev does not).
if (window.location.pathname.startsWith("/s/")) {
  const meta = document.createElement("meta");
  meta.name = "referrer";
  meta.content = "no-referrer";
  document.head.appendChild(meta);
}

setupIonicReact({
  animated: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
});

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
