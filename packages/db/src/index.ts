export {
  APP_ROLES,
  type AppRole,
  AUTH_ADMIN_ROLE,
  AUTH_SCHEMA,
  type BootstrapOptions,
  bootstrap,
  bootstrapFromEnv,
  JWT_ROLES,
  PGBOSS_SCHEMA,
} from "./bootstrap.js";
export {
  isProduction,
  knownSecrets,
  MIN_DATA_ENCRYPTION_KEY_LENGTH,
  requireApiDbPassword,
  requireAuthDbPassword,
  requireDatabaseUrl,
  requireDataEncryptionKey,
  requireWorkerDbPassword,
  type SeedMode,
  seedEnabled,
  seedMode,
} from "./env.js";
export {
  type AppliedMigration,
  MIGRATIONS_DIR,
  MIGRATIONS_TABLE,
  type MigrationDirection,
  type RunMigrationsOptions,
  runMigrations,
} from "./migrate.js";
export { describeError, redactSecrets } from "./redact.js";
// Store-review family (docs/plans/step-9.md 2.9 item 6): `pnpm db:review-family`.
export {
  CONFIRM_PRODUCTION_FLAG,
  parseReviewFamilyArgs,
  provisionReviewFamily,
  REVIEW_BABY_NAME,
  REVIEW_PHOTO_COUNT,
  REVIEW_PHOTOS,
  REVIEW_USAGE,
  type ReviewFamilyArgs,
  type ReviewFamilyOptions,
  type ReviewFamilyResult,
  ReviewUsageError,
  reviewBabyId,
  reviewId,
  reviewOriginalKey,
  reviewPhotoId,
} from "./review-family.js";
export { DEMO, type SeedOptions, type SeedResult, seed, seedFromEnv } from "./seed.js";
// Test/CI only (docs/plans/step-2.md 2.1): never used by the running stack.
export { AUTH_USERS_STUB_SQL, appRoleUrl, ensureAuthSchemaStub } from "./test-support.js";
// Dev/operator plan setter (docs/plans/step-6.md D7): `pnpm db:plan`.
export {
  backfillHint,
  PLANS,
  type Plan,
  PRODUCTION_FLAG,
  parseSetPlanArgs,
  type SetPlanArgs,
  type SetPlanOptions,
  type SetPlanResult,
  searchBackfillHint,
  setPlan,
  UsageError,
} from "./tools/set-plan.js";
