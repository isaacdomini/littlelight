import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const apiTarget = process.env.VITE_PROXY_API_TARGET ?? "http://api:3000";
const authTarget = process.env.VITE_PROXY_AUTH_TARGET ?? "http://auth:9999";
const extraHosts = (process.env.VITE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// Production nginx serves the extensionless AASA file as application/json; match it in dev/preview.
function aasaJson(): Plugin {
  const handler = (
    req: { url?: string },
    res: { setHeader(k: string, v: string): void },
    next: () => void,
  ) => {
    if (req.url?.split("?")[0] === "/.well-known/apple-app-site-association") {
      res.setHeader("Content-Type", "application/json");
    }
    next();
  };
  return {
    name: "littlelight-aasa-json",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

// Same routing as production nginx: /api/* -> api:3000/*, /auth/* -> auth:9999/* (prefix stripped).
const proxy = {
  "/api": {
    target: apiTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
  "/auth": {
    target: authTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/auth/, ""),
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), aasaJson()],
  server: {
    // `web` is required: GoTrue fetches its email templates from http://web:8080/email-templates/*.
    allowedHosts: ["web", ...extraHosts],
    proxy,
    watch: process.env.VITE_USE_POLLING === "1" ? { usePolling: true } : undefined,
  },
  preview: {
    allowedHosts: ["web", ...extraHosts],
    proxy,
  },
});
