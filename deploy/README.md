# Production deployment: server folder layout

Tinyglow runs from one folder of the server's `servers` repo, with this repo cloned inside it and
all persistent data under `/mnt/data/tinyglow/`. cloudflared runs outside this stack.

```
servers/tinyglow/
  docker-compose.yml        copy of deploy/server-compose.example.yml (Compose `include:`)
  .env                      from app/.env.example; git-ignored by the servers repo (**/.env)
  .env.offsite              optional: restic settings for the off-site copy (**/.env.* ignored)
  app/                      this repo (submodule or plain clone)

/mnt/data/tinyglow/
  postgres/   DB_DATA_PATH  Postgres PGDATA        owner 999:999 (postgres in the image), 700
  photos/     STORAGE_PATH  MinIO data             owner root (MinIO runs as root), 700
  backups/    BACKUP_PATH   nightly pg_dump files  owner root (backup job runs as root), 700
  scratch/    WORKER_SCRATCH_PATH  worker video staging (original + rendition while ffmpeg runs;
                            emptied after each job, not backed up)  owner 1000:1000 (node in the
                            worker image), 700; keep >= 6 GB free on its filesystem
```

There are no named volumes: `docker compose down -v` deletes nothing on disk. Each folder must
exist before `up` (the mounts use `create_host_path: false`, so a missing or unmounted data disk
fails the start instead of Docker creating empty folders on the root filesystem).

## First install

```sh
# 1. App folder + code (pick one)
cd ~/servers && mkdir tinyglow && cd tinyglow
git clone <tinyglow repo url> app                      # plain clone; then add `tinyglow/app/`
                                                       #   to the servers repo's .gitignore
# or, from the servers repo root:
#   git submodule add <tinyglow repo url> tinyglow/app  # pins a commit in the servers repo

# 2. Outer compose file and .env
cp app/deploy/server-compose.example.yml docker-compose.yml
cp app/.env.example .env && chmod 600 .env && $EDITOR .env

# 3. Data folders
sudo install -d -m 755 /mnt/data/tinyglow
sudo install -d -m 700 -o 999 -g 999 /mnt/data/tinyglow/postgres
sudo install -d -m 700 /mnt/data/tinyglow/photos /mnt/data/tinyglow/backups
sudo install -d -m 700 -o 1000 -g 1000 /mnt/data/tinyglow/scratch

# 4. Start (builds api, worker, web and db-tools images on the server)
docker compose up -d --build --wait
docker compose ps
curl -fsS http://127.0.0.1:6987/api/healthz          # {"ok":true,...}
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:16987/minio/health/live   # 200
```

`postgres/` must be empty on first start (initdb refuses a non-empty folder) or hold an existing
PG 17 cluster. The image's entrypoint chowns it to 999 itself when started as root; the explicit
`-o 999 -g 999` also covers file systems where root cannot chown (NFS with root_squash).

## Updating

```sh
cd ~/servers/tinyglow
git -C app pull                                        # plain clone
# or: git submodule update --remote tinyglow/app      # from the servers root, then commit
docker compose up -d --build --wait                    # migrate runs before api/worker start
docker image prune -f
```

## Every other command

Run from `servers/tinyglow/` exactly as documented elsewhere for the repo root:
`docker compose logs -f api`, `docker compose run --rm migrate pnpm db:plan ...`,
`docker compose run --rm --no-deps --entrypoint bash backup /scripts/restore-test.sh`,
`docker compose exec db psql -U postgres tinyglow`, `docker compose down`.

Without the outer file, the equivalent is
`docker compose --env-file .env -f app/docker-compose.yml <command>` (paths still resolve
against `app/`).

## Ports and cloudflared

| Hostname | Tunnel service | Published by |
| --- | --- | --- |
| `tinyglow.app` | `http://<WEB_BIND>:6987` | web (nginx) |
| `files.tinyglow.app`, path `^/tinyglow/.` | `http://<STORAGE_BIND>:16987` | storage (MinIO S3 API) |

`WEB_BIND` / `STORAGE_BIND`: `127.0.0.1` if cloudflared runs on the host (package, or a
container with `network_mode: host`); the server's LAN IP or `0.0.0.0` if it runs in a bridged
container or on another machine, with both ports firewalled to cloudflared only. See
`docker/cloudflared/config.example.yml` for the ingress rules and the required cache rule.

## Backups

- Nightly `pg_dump` to `backups/` by the `backup` service (35 days).
- Off-site (restic, e.g. Backblaze B2) of `photos/` + `backups/` from host cron, settings in
  `servers/tinyglow/.env.offsite` (or `/etc/tinyglow/offsite.env`):
  ```cron
  30 4 * * * root OFFSITE_ENV=/home/<user>/servers/tinyglow/.env.offsite /home/<user>/servers/tinyglow/app/docker/backup/offsite-backup.sh >>/var/log/tinyglow-offsite.log 2>&1
  0 5 1 * *  root OFFSITE_ENV=/home/<user>/servers/tinyglow/.env.offsite /home/<user>/servers/tinyglow/app/docker/backup/offsite-restore-test.sh >>/var/log/tinyglow-offsite.log 2>&1
  ```
  The restore test reads the stack's `.env` from `servers/tinyglow/.env` (or `STACK_ENV=`).
- `postgres/` is not copied raw: the nightly dump is the consistent copy. `scratch/` is never
  copied (work files only).
