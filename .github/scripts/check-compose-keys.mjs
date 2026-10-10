#!/usr/bin/env node
// CI guard: provider keys reach only the services allowed to hold them (docs/plans/step-6.md
// 2.10, docs/plans/step-7.md 2.11, docs/plans/step-10.md 2.10):
//
//   OPENAI_API_KEY               worker + api   (vision batches / document embeddings; chat /
//                                               query embeddings)
//   ANTHROPIC_API_KEY            worker only    (fallback vision adapter; never the api, migrate or web)
//   GOOGLE_IMPORT_CLIENT_ID      worker + api   (Google Photos import OAuth client)
//   GOOGLE_IMPORT_CLIENT_SECRET  worker + api   (never web, migrate, google-fake or anything else)
//
// Reads `docker compose ... config --format json` on stdin, rendered with CANARY key values (the
// CI step puts them in a throwaway .env.local for the dev file and in the shell environment for
// the production file), and fails if a canary shows up in a service that must not hold that key,
// or does not reach a service that needs it. Values are never printed, only service names.
// Every key below needs its canary supplied (all four, exactly the CANARY strings).
//
//   docker compose -f docker-compose.dev.yml config --format json \
//     | node .github/scripts/check-compose-keys.mjs dev
//
// `node .github/scripts/check-compose-keys.mjs --print-env` prints the KEY=canary lines (for the
// throwaway .env.local / the shell), so callers never hard-code the list.
//
// Photo-import provider placement (docs/plans/step-10.md 2.9, 2.10), by label:
//   dev   a `google-fake` service with a healthcheck, NODE_ENV not production and no database or
//         S3 credential; api and worker render GOOGLE_IMPORT_PROVIDER=fake (the default) and
//         depend on google-fake being healthy.
//   prod  no `google-fake` service and no string mentioning google-fake or GOOGLE_IMPORT_FAKE_*
//         anywhere; api and worker render NODE_ENV=production and GOOGLE_IMPORT_PROVIDER `none`
//         or `live` (never `fake`; .env.example sets `none`).
//
// Only Node built-ins are used, so it runs before or without `pnpm install`.
import { readFileSync } from "node:fs";

const CANARY = {
  OPENAI_API_KEY: "ci-canary-openai-key-not-a-secret",
  ANTHROPIC_API_KEY: "ci-canary-anthropic-key-not-a-secret",
  GOOGLE_IMPORT_CLIENT_ID: "ci-canary-google-import-client-id",
  GOOGLE_IMPORT_CLIENT_SECRET: "ci-canary-google-import-secret-not-a-secret",
};
const ALLOWED = {
  OPENAI_API_KEY: new Set(["api", "worker"]),
  ANTHROPIC_API_KEY: new Set(["worker"]),
  GOOGLE_IMPORT_CLIENT_ID: new Set(["api", "worker"]),
  GOOGLE_IMPORT_CLIENT_SECRET: new Set(["api", "worker"]),
};

if (process.argv[2] === "--print-env") {
  for (const [key, canary] of Object.entries(CANARY)) console.log(`${key}=${canary}`);
  process.exit(0);
}

const label = process.argv[2] ?? "compose";
let config;
try {
  config = JSON.parse(readFileSync(0, "utf8"));
} catch (err) {
  console.error(`::error::${label}: cannot parse compose config JSON from stdin: ${err.message}`);
  process.exit(1);
}

const services = config?.services ?? {};
const errors = [];
for (const required of ["api", "worker", "web", "migrate"]) {
  if (!services[required]) errors.push(`${label}: service "${required}" is missing`);
}

/** Every string anywhere in the service definition (environment, command, labels, ...). */
function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

for (const [name, svc] of Object.entries(services)) {
  const all = strings(svc);
  for (const [key, canary] of Object.entries(CANARY)) {
    const has = all.some((s) => s.includes(canary));
    if (has && !ALLOWED[key].has(name)) {
      errors.push(
        `${label}: ${key} reaches service "${name}" (allowed: ${[...ALLOWED[key]].join(", ")})`,
      );
    }
    if (!has && ALLOWED[key].has(name)) {
      errors.push(`${label}: ${key} does not reach service "${name}"`);
    }
  }
}

const env = (name) => services[name]?.environment ?? {};
if (label === "dev") {
  const fake = services["google-fake"];
  if (!fake) errors.push(`dev: service "google-fake" is missing`);
  else {
    if (!fake.healthcheck || fake.healthcheck.disable) {
      errors.push(`dev: google-fake has no healthcheck`);
    }
    if (env("google-fake").NODE_ENV === "production") {
      errors.push(`dev: google-fake runs with NODE_ENV=production`);
    }
    for (const k of Object.keys(env("google-fake"))) {
      if (
        /^(DATABASE_URL|\w*DB_PASSWORD|S3_\w*KEY|S3_ENDPOINT|DATA_ENCRYPTION_KEY|JWT_SECRET)$/.test(
          k,
        )
      ) {
        errors.push(`dev: google-fake receives ${k} (it needs no database or storage access)`);
      }
    }
  }
  for (const name of ["api", "worker"]) {
    if (env(name).GOOGLE_IMPORT_PROVIDER !== "fake") {
      errors.push(`dev: ${name} GOOGLE_IMPORT_PROVIDER is not "fake" by default`);
    }
    if (services[name]?.depends_on?.["google-fake"]?.condition !== "service_healthy") {
      errors.push(`dev: ${name} does not wait for google-fake to be healthy`);
    }
  }
} else if (label === "prod") {
  for (const [name, svc] of Object.entries(services)) {
    if (
      name === "google-fake" ||
      strings(svc).some((v) => /google-fake|GOOGLE_IMPORT_FAKE_/.test(v))
    ) {
      errors.push(`prod: service "${name}" refers to the fake Google server`);
    }
    for (const k of Object.keys(svc.environment ?? {})) {
      if (k.startsWith("GOOGLE_IMPORT_FAKE_")) errors.push(`prod: service "${name}" gets ${k}`);
    }
  }
  for (const name of ["api", "worker"]) {
    if (env(name).NODE_ENV !== "production")
      errors.push(`prod: ${name} NODE_ENV is not production`);
    const provider = env(name).GOOGLE_IMPORT_PROVIDER;
    if (provider !== "none" && provider !== "live") {
      errors.push(
        `prod: ${name} GOOGLE_IMPORT_PROVIDER is "${provider ?? "(unset)"}" (none or live only)`,
      );
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
const placement = Object.entries(ALLOWED)
  .map(([key, allowed]) => `${key} only in ${[...allowed].join(" + ")}`)
  .join(", ");
const importNote =
  label === "dev"
    ? "; google-fake healthy-gated, api + worker on the fake"
    : label === "prod"
      ? "; no fake Google service, api + worker never on the fake"
      : "";
console.log(
  `${label}: ${placement}${importNote} (${Object.keys(services).length} services checked)`,
);
