import {
  IMPORT_BATCHES_PER_USER_PER_HOUR,
  IMPORT_CONNECTS_PER_USER_PER_HOUR,
} from "@tinyglow/shared";
import type { FastifyInstance } from "fastify";
import { createThrottle, type Throttle } from "../auth";
import { googleImportSettings } from "../config";
import { importBatchRoutes } from "./batches";
import { createGoogleClient, type FetchLike, type GoogleClient } from "./google/client";
import { googleImportRoutes } from "./google-routes";
import { importSourcesRoutes } from "./sources";

// Photo import API (docs/plans/step-10.md 2.6, task 10.8): Apple album sync status rows
// (sources.ts), the Google connection (google-routes.ts) and Google Picker batches (batches.ts).
// `revokeGoogleConnection` is exported for the account-deletion hook (2.8, task 10.10).

export { createGoogleClient, type GoogleClient, GoogleError } from "./google/client";
export { revokeGoogleConnection } from "./google/connection";

const HOUR_MS = 3_600_000;

export interface ImportsRoutesOptions {
  /** Override the Google client (tests); `null` = provider `none`. Default: from the config. */
  google?: GoogleClient | null;
  /** `fetch` for the default Google client (tests point it at an in-process fake). */
  fetch?: FetchLike;
  /** Override the per-user throttles (tests). */
  connectThrottle?: Throttle;
  createThrottle?: Throttle;
}

/** Decorate `app.googleImport` and register every import route. */
export function importsRoutes(app: FastifyInstance, opts: ImportsRoutesOptions = {}): void {
  const google =
    opts.google !== undefined
      ? opts.google
      : createGoogleClient(googleImportSettings(app.config), opts.fetch);
  app.decorate("googleImport", google);
  const connectThrottle =
    opts.connectThrottle ??
    createThrottle({ limit: IMPORT_CONNECTS_PER_USER_PER_HOUR, windowMs: HOUR_MS });
  const batchThrottle =
    opts.createThrottle ??
    createThrottle({ limit: IMPORT_BATCHES_PER_USER_PER_HOUR, windowMs: HOUR_MS });
  app.addHook("onClose", async () => {
    connectThrottle.close();
    batchThrottle.close();
  });
  importSourcesRoutes(app);
  googleImportRoutes(app, { connectThrottle });
  importBatchRoutes(app, { createThrottle: batchThrottle });
}
