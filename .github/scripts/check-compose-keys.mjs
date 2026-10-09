#!/usr/bin/env node
// CI guard: provider keys reach only the services allowed to hold them (docs/plans/step-6.md
// 2.10, docs/plans/step-7.md 2.11):
//
//   OPENAI_API_KEY     worker + api   (vision batches / document embeddings; chat / query embeddings)
//   ANTHROPIC_API_KEY  worker only    (fallback vision adapter; never the api, migrate or web)
//
// Reads `docker compose ... config --format json` on stdin, rendered with CANARY key values (the
// CI step puts them in a throwaway .env.local for the dev file and in the shell environment for
// the production file), and fails if a canary shows up in a service that must not hold that key,
// or does not reach a service that needs it. Values are never printed, only service names.
//
//   docker compose -f docker-compose.dev.yml config --format json \
//     | node .github/scripts/check-compose-keys.mjs dev
//
// Only Node built-ins are used, so it runs before or without `pnpm install`.
import { readFileSync } from "node:fs";

const CANARY = {
  OPENAI_API_KEY: "ci-canary-openai-key-not-a-secret",
  ANTHROPIC_API_KEY: "ci-canary-anthropic-key-not-a-secret",
};
const ALLOWED = {
  OPENAI_API_KEY: new Set(["api", "worker"]),
  ANTHROPIC_API_KEY: new Set(["worker"]),
};

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

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(
  `${label}: OPENAI_API_KEY only in api + worker, ANTHROPIC_API_KEY only in worker (${Object.keys(services).length} services checked)`,
);
