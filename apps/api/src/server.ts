import { buildApp } from "./app";
import { ConfigError, loadConfig } from "./config";

function readConfig() {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Field names and expectations only, never values.
      console.error(`[api] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const config = readConfig();
const app = await buildApp({ config });

let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, "error during shutdown");
        process.exit(1);
      });
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
