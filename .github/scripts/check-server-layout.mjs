#!/usr/bin/env node
// CI guard for the production server layout (deploy/README.md):
//
//   servers/tinyglow/docker-compose.yml   = deploy/server-compose.example.yml (Compose include)
//   servers/tinyglow/.env                 = .env.example (the only interpolation source)
//   servers/tinyglow/app/                 = this repo
//
// Reads `docker compose config --format json`, run in the outer folder, on stdin and checks that
// the project is named tinyglow, build contexts and ./docker/... mounts resolve against app/,
// every persistent folder is the /mnt/data/tinyglow bind mount from .env.example, the two
// published ports are .env.example's loopback 6987 / 16987, and there are no named volumes.
//
//   (cd "$outer" && docker compose config --format json) \
//     | node .github/scripts/check-server-layout.mjs "$outer/app"
import { readFileSync } from "node:fs";

const app = process.argv[2];
if (!app) {
  console.error("usage: check-server-layout.mjs <outer>/app < config.json");
  process.exit(2);
}
const c = JSON.parse(readFileSync(0, "utf8"));
const errors = [];

if (c.name !== "tinyglow") errors.push(`project name is ${c.name}, expected tinyglow`);
for (const s of ["api", "worker", "web", "migrate", "db-init"]) {
  const ctx = c.services[s]?.build?.context;
  if (ctx !== app) errors.push(`${s}: build context ${ctx}, expected ${app}`);
}

const mounted = (svc, source, target) =>
  (c.services[svc]?.volumes ?? []).some((v) => v.source === source && v.target === target);
const binds = [
  ["db", "/mnt/data/tinyglow/postgres", "/var/lib/postgresql/data"],
  ["storage", "/mnt/data/tinyglow/photos", "/data"],
  ["worker", "/mnt/data/tinyglow/photos", "/storage"],
  ["backup", "/mnt/data/tinyglow/backups", "/backups"],
  ["backup", `${app}/docker/backup`, "/scripts"],
  ["storage-init", `${app}/docker/minio`, "/minio"],
];
for (const [svc, source, target] of binds) {
  if (!mounted(svc, source, target)) errors.push(`${svc}: bind ${source} -> ${target} missing`);
}
for (const [name, svc] of Object.entries(c.services)) {
  for (const v of svc.volumes ?? []) {
    if (v.type === "volume") errors.push(`${name}: named volume ${v.source}`);
    if (v.type === "bind" && v.source.startsWith("/mnt/") && v.bind?.create_host_path !== false)
      errors.push(`${name}: ${v.source} must set bind.create_host_path: false`);
  }
}
if (Object.keys(c.volumes ?? {}).length)
  errors.push(`top-level named volumes: ${Object.keys(c.volumes).join(", ")}`);

const published = (svc) => (c.services[svc]?.ports ?? []).map((p) => `${p.host_ip}:${p.published}`);
const expectPorts = { web: ["127.0.0.1:6987"], storage: ["127.0.0.1:16987"] };
for (const name of Object.keys(c.services)) {
  const got = published(name).join(",");
  const want = (expectPorts[name] ?? []).join(",");
  if (got !== want) errors.push(`${name}: publishes [${got}], expected [${want}]`);
}

if (errors.length) {
  for (const e of errors) console.error(`server layout: ${e}`);
  process.exit(1);
}
console.log(
  `server layout ok: project tinyglow, paths resolve against ${app}, data under /mnt/data/tinyglow, ports 6987/16987`,
);
