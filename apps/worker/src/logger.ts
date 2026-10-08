import { pino } from "pino";
import type { WorkerConfig } from "./config";

/** Worker logger. Never log photo bytes, GPS, parent notes, prompts or credentials. */
export function createLogger(config: Pick<WorkerConfig, "LOG_LEVEL" | "NODE_ENV">) {
  return pino({
    name: "worker",
    level: config.LOG_LEVEL,
    redact: { paths: ["*.authorization", "*.password", "*.secretAccessKey"], censor: "[redacted]" },
    ...(config.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
