#!/usr/bin/env node
// CI guard for `pnpm test:integration` (docs/plans/step-3.md 3.13, step-4.md 4.10).
//
// Every integration test is `describe.skipIf(!databaseUrl)` (apps/worker: also S3_ENDPOINT), so
// a missing or misspelled variable turns the whole run into a green "all skipped". This reads
// Vitest's JSON report and fails unless, for each expected project, at least one test actually
// ran and no test file was skipped in its entirety.
//
//   node .github/scripts/check-integration-report.mjs <report.json> <project-dir>...
//   e.g.  ... integration.json packages/db apps/api apps/worker
//
// <project-dir> is a repo-relative directory; a test file belongs to it when its path contains
// `/<project-dir>/`. Only Node built-ins are used, so it runs before or without `pnpm install`.
import { readFileSync } from "node:fs";

const [reportPath, ...projects] = process.argv.slice(2);
if (!reportPath || projects.length === 0) {
  console.error("usage: check-integration-report.mjs <report.json> <project-dir>...");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`::error::cannot read Vitest JSON report ${reportPath}: ${err.message}`);
  process.exit(1);
}

const files = Array.isArray(report.testResults) ? report.testResults : [];
const errors = [];

for (const dir of projects) {
  const needle = `/${dir.replace(/^\/+|\/+$/g, "")}/`;
  const mine = files.filter((f) => typeof f.name === "string" && f.name.includes(needle));
  let ran = 0;
  let skipped = 0;
  for (const f of mine) {
    const tests = Array.isArray(f.assertionResults) ? f.assertionResults : [];
    const executed = tests.filter((t) => t.status === "passed" || t.status === "failed").length;
    ran += executed;
    skipped += tests.length - executed;
    if (executed === 0) {
      errors.push(`${f.name}: no test executed (${tests.length} skipped/pending)`);
    }
  }
  console.log(`${dir}: ${mine.length} files, ${ran} tests executed, ${skipped} skipped`);
  if (mine.length === 0) errors.push(`${dir}: no integration test files in the report`);
  else if (ran === 0) {
    errors.push(
      `${dir}: 0 tests executed (are DATABASE_URL and, for apps/worker, S3_ENDPOINT set?)`,
    );
  }
}

if (report.success !== true) errors.push("report.success is not true");

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(`integration report OK: ${report.numPassedTests}/${report.numTotalTests} passed`);
