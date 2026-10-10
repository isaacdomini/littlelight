import { setupIonicReact } from "@ionic/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { captureWebError, initTelemetry } from "./lib/telemetry";
import { isNative } from "./platform/platform";
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

async function start() {
  // Native only: Keychain token store, background uploader, token refresh. A lazy chunk, so the
  // web bundle never loads Capacitor code.
  void initTelemetry();
  const native = isNative() ? await import("./platform/native/bootstrap") : null;
  await native?.bootstrapNative();
  if (!root) return;
  createRoot(root, {
    onUncaughtError: (error) => captureWebError(error),
    onCaughtError: (error) => captureWebError(error),
  }).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void native?.afterFirstRender();
}

void start();
