import { pino } from "pino";
import type { WorkerConfig } from "./config";

/** Worker logger. Never log photo bytes, GPS, parent notes, prompts or credentials. */
export function createLogger(config: Pick<WorkerConfig, "LOG_LEVEL" | "NODE_ENV">) {
  return pino({
    name: "worker",
    level: config.LOG_LEVEL,
    // Defense in depth: push code never puts a device token, provider JWT or OAuth token in a
    // log object (docs/plans/step-9.md 2.8); these paths censor one if it ever slips in.
    redact: {
      paths: [
        "authorization",
        "*.authorization",
        "*.password",
        "*.secretAccessKey",
        "token",
        "*.token",
        "*.access_token",
        "*.assertion",
        // Data export (docs/plans/review-fixes.md 2.3): the code logs ids, counts, bytes and
        // categories only; these censor an address, a coordinate or a key if one ever slips in.
        "email",
        "*.email",
        "to",
        "*.to",
        "gps_lat",
        "gps_lng",
        "*.gps_lat",
        "*.gps_lng",
        "*.storage_key",
        "*.storageKey",
        "*.url",
      ],
      censor: "[redacted]",
    },
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
