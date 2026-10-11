# Putting Tinyglow into production

This guide takes Tinyglow from this repo to a running production server. It assumes:
- **Server layout:** the server is laid out like the `servers` repo, with one folder per app and
  `docker compose up -d` run inside that folder.
- **Data:** all data lives under `/mnt/data/tinyglow/`.
- **Cloudflare:** already set up, with `tinyglow.app` → port **6987** and `files.tinyglow.app` →
  port **16987**.

Work through the parts in order. Parts A–F get the web app live. Parts G–I are optional features
and the phone apps, and you can do them later.

---

## Part A: Accounts and values to collect first

You need these before the first start:

| What | Why | Where |
| --- | --- | --- |
| **Domain `tinyglow.app`** | The app and photo hosts | Register it now. It was free on 2026-10-10. No trademark search was done. |
| **Email sending (SMTP)** | Sign-in codes and invite emails. Without it nobody can sign in. | [Postmark](https://postmarkapp.com) or [Resend](https://resend.com), with a verified sender such as `noreply@tinyglow.app` |
| **OpenAI API key** | AI descriptions, search and chat (paid tier only) | platform.openai.com → API keys. Optional: without it the app runs with AI turned off. |
| **Off-site backup bucket** | A copy of photos and database dumps off the server | Backblaze B2 (or any S3), with an application key scoped to one bucket |

Optional, any time later: Cloudflare Turnstile, Sentry, Google Photos import, Apple and Google
sign-in, and the push notification keys. See Part G.

---

## Part B: Prepare the server

### 1. Create the data folders

The stack refuses to start if any of these folders is missing (`create_host_path: false`). That
stops it from quietly writing to the root disk when `/mnt/data` isn't mounted.

```sh
sudo install -d -m 755 /mnt/data/tinyglow
sudo install -d -m 700 -o 999 -g 999 /mnt/data/tinyglow/postgres   # database (postgres runs as uid 999)
sudo install -d -m 700 /mnt/data/tinyglow/photos                    # photo library (MinIO)
sudo install -d -m 700 /mnt/data/tinyglow/backups                   # nightly database dumps
```

`postgres/` must be empty on the first start.

### 2. Create the app folder and get the code

```sh
cd ~/servers
mkdir tinyglow && cd tinyglow
git clone <tinyglow repo url> app
```

Then add `tinyglow/app/` to the servers repo's `.gitignore`, so the servers repo doesn't treat it
as an embedded repo.

**Alternative: a submodule.** From the servers repo root, run
`git submodule add <tinyglow repo url> tinyglow/app`. This pins the exact app commit in your
servers repo. The servers repo is public, so the submodule URL becomes visible, but not its
contents.

### 3. Add the outer compose file

```sh
cp app/deploy/server-compose.example.yml docker-compose.yml
```

You never need to edit this file. It names the project `tinyglow` and includes
`app/docker-compose.yml` with your `.env`, so everything inside the app (build contexts,
`./docker/...` mounts) resolves correctly.

### 4. Create `.env`

```sh
cp app/.env.example .env
chmod 600 .env
```

Your servers repo already ignores `**/.env` and `**/.env.*`, so `.env` and `.env.offsite` are
never committed. Don't name the off-site file `offsite.env`, because that name is not ignored.

The resulting folder:

```
~/servers/tinyglow/
  docker-compose.yml   (copy of app/deploy/server-compose.example.yml)
  .env                 (your secrets, chmod 600)
  .env.offsite         (off-site backup settings, Part F)
  app/                 (this repo)
/mnt/data/tinyglow/
  postgres/  photos/  backups/
```

---

## Part C: Fill in `.env`

Generate each secret separately. Use **hex** for every password and key: database passwords sit
inside `postgres://` URLs, where other characters cause problems.

```sh
openssl rand -hex 32   # 64 hex chars: passwords, JWT_SECRET, DATA_ENCRYPTION_KEY
openssl rand -hex 20   # 40 hex chars: MinIO secret keys
openssl rand -hex 8    # 16 hex chars: MinIO access keys / root user
```

### C1. Required values

Everything below is needed for the first start. The values for your setup are filled in, and
`<…>` marks what you generate or obtain.

```dotenv
# --- Data folders (Part B) ---
DB_DATA_PATH=/mnt/data/tinyglow/postgres
STORAGE_PATH=/mnt/data/tinyglow/photos
BACKUP_PATH=/mnt/data/tinyglow/backups

# --- Public addresses and ports (your Cloudflare setup) ---
PUBLIC_URL=https://tinyglow.app
S3_PUBLIC_ENDPOINT=https://files.tinyglow.app
GOTRUE_URI_ALLOW_LIST=https://tinyglow.app/**
WEB_PORT=6987
STORAGE_PORT=16987
WEB_BIND=127.0.0.1        # see "Which bind address?" below
STORAGE_BIND=127.0.0.1
TZ=America/New_York       # your server's time zone (nightly backup hour uses it)

# --- Database passwords: each openssl rand -hex 32, all different ---
POSTGRES_PASSWORD=<hex 64>
AUTH_DB_PASSWORD=<hex 64>
API_DB_PASSWORD=<hex 64>
WORKER_DB_PASSWORD=<hex 64>

# --- App secrets: each openssl rand -hex 32 ---
JWT_SECRET=<hex 64>
DATA_ENCRYPTION_KEY=<hex 64>

# --- Photo storage (MinIO): all six different ---
S3_ROOT_USER=<hex 16>             # openssl rand -hex 8
S3_ROOT_PASSWORD=<hex 40>         # openssl rand -hex 20
S3_API_ACCESS_KEY=<hex 16>
S3_API_SECRET_KEY=<hex 40>
S3_WORKER_ACCESS_KEY=<hex 16>
S3_WORKER_SECRET_KEY=<hex 40>
S3_BUCKET=tinyglow                # must match the Cloudflare path rule ^/tinyglow/.

# --- Email (sign-in codes) ---
# Postmark: host smtp.postmarkapp.com, user AND pass = the Server API token
# Resend:   host smtp.resend.com,      user = resend, pass = re_...
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=587
SMTP_USER=<from provider>
SMTP_PASS=<from provider>
SMTP_SECURE=false                 # true only if you use port 465
MAIL_FROM=noreply@tinyglow.app    # must be a verified sender (SPF/DKIM set up at the provider)
```

**Keep two values safe off the server**, for example in your password manager:
- **`DATA_ENCRYPTION_KEY`** encrypts photo locations. It is not in any backup, and if you lose or
  change it, existing location data can't be read.
- **`JWT_SECRET`**: changing it signs everyone out, including family share viewers.

Never change **`S3_ROOT_PASSWORD`** once photos exist.

**Which bind address?** It depends on where cloudflared runs:
- **On this server** (installed package, or a container with `network_mode: host`): keep
  `127.0.0.1`, and the tunnel targets `http://localhost:6987` and `http://localhost:16987`.
- **In a normal (bridged) Docker container on this server:** set both binds to the server's LAN
  IP, and point the tunnel at that IP. Alternatively, use `0.0.0.0` with `host.docker.internal`
  plus `extra_hosts: host-gateway`. Firewall ports 6987 and 16987 so only cloudflared can reach
  them.
- **On another machine:** use the server's LAN IP and firewall the ports to that machine.

Anything that can reach these ports bypasses Cloudflare, so keep them closed to everything else.

### C2. AI (recommended)

```dotenv
OPENAI_API_KEY=sk-...             # empty = AI features off
# Defaults are already right; change only if needed:
# VISION_MODEL=gpt-6-luna  CHAT_MODEL=gpt-6-luna  EMBED_MODEL=text-embedding-3-small  EMBED_DIMS=1024
# AI_BABY_MONTHLY_BUDGET_USD=3     # per-album monthly spend cap
```

Free-tier photos are never sent to a model, whatever you set here.

### C3. Leave these as they are (defaults are correct)

`NODE_ENV`, `API_HOST` and `API_PORT` are fixed in compose. The S3 endpoint, region and path
style, all AI and search tuning, and the backup retention (35 days at 03:00) also have the right
defaults.

Never set:
- `GOOGLE_IMPORT_PROVIDER=fake` or `PUSH_PROVIDER=fake`; production refuses fake providers.
- `SUPABASE_*`, `POSTMARK_TOKEN`, `RESEND_API_KEY` or `CLOUDFLARE_TUNNEL_TOKEN`; they aren't used.

The full list of every setting, with ranges and which service reads it, is in `app/.env.example`.

---

## Part D: Cloudflare

You already route both hostnames. Check these settings in **Zero Trust → Networks → Tunnels →
your tunnel → Public hostnames**:

1. **`tinyglow.app` → `HTTP localhost:6987`** (or your LAN IP, per the bind choice).
2. **`files.tinyglow.app` → `HTTP localhost:16987`**, with these settings:
   - **Path:** `^/tinyglow/.`. Only photo objects are reachable. MinIO's admin, metrics and listing
     endpoints then never reach the internet.
   - **HTTP Host Header: leave empty.** MinIO checks photo-link signatures against
     `files.tinyglow.app`, so overriding the header breaks every upload and download.

   `app/docker/cloudflared/config.example.yml` has the same rules in config-file form.
3. **Cache rule (required).** In the `tinyglow.app` zone, go to Caching → Cache Rules → Create rule:
   - Name: `tinyglow files bypass`
   - Expression: `(http.host eq "files.tinyglow.app")`
   - Action: **Bypass cache**

   This stops photos from ever being stored at Cloudflare's edge, so a revoked family link leaves
   nothing behind.
4. **Recommended:** in Caching → Configuration, turn on the **CSAM Scanning Tool**.
5. **Email DNS:** add the SPF, DKIM (and ideally DMARC) records your SMTP provider gives you for
   `tinyglow.app`, so sign-in emails don't land in spam.

---

## Part E: First start

```sh
cd ~/servers/tinyglow
docker compose up -d --build --wait
```

The first start builds the api, worker, web and database-tools images on the server, which takes
a few minutes. It then runs, in order:
1. database setup (roles and passwords);
2. migrations;
3. storage setup (bucket and keys);
4. the app.

**Check it on the server:**

```sh
docker compose ps                                                        # all healthy; db-init, storage-init, migrate "exited (0)"
curl -fsS http://127.0.0.1:6987/api/healthz                              # {"status":"ok", ... db ok, storage ok}
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:16987/minio/health/live   # 200
ls /mnt/data/tinyglow/postgres /mnt/data/tinyglow/photos                 # both now have data
```

**Check it from outside:**
1. Open **https://tinyglow.app**.
2. Sign up with your email, enter the 6-digit code from the email, and create your baby's album.
3. Upload a few photos. Thumbnails should appear within seconds.
4. Check the cache rule:
   - Open a photo, copy its image address (it starts with `https://files.tinyglow.app/tinyglow/…`).
   - Run `curl -sI '<that address>' | grep -iE 'cf-cache-status|cache-control'`.
   - Expect `cf-cache-status: DYNAMIC` or `BYPASS`, and `cache-control: private…`.
5. Run `curl -sI https://files.tinyglow.app/` and expect **404**, because only photo paths are
   public.

**If something fails:**
- `docker compose logs -f api` (also `worker`, `auth`, `storage`). Logs never contain photos, GPS
  or tokens.
- No sign-in email: check the `SMTP_*` values and the sender verification, then
  `docker compose logs auth`.
- Photos fail to load: check the files hostname has the path rule and no Host Header override.

---

## Part F: Backups

**On-server (automatic).** The `backup` service writes a database dump to
`/mnt/data/tinyglow/backups/` every night at 03:00 and keeps 35 days. The very first dump, made at
startup, is almost empty; the 03:00 dump is the first complete one.

**Test a restore** (do this once a week or so):

```sh
docker compose run --rm --no-deps --entrypoint bash backup /scripts/restore-test.sh
```

**Off-site (do this before you rely on the app).** Photos and dumps are copied with restic to
Backblaze B2 or any S3 bucket.

1. Create `~/servers/tinyglow/.env.offsite` (`chmod 600`):
   ```dotenv
   RESTIC_REPOSITORY=s3:https://s3.<region>.backblazeb2.com/<bucket>/tinyglow
   RESTIC_PASSWORD=<openssl rand -hex 32>        # keep a copy off the server; without it the backup is useless
   AWS_ACCESS_KEY_ID=<B2 application key ID>
   AWS_SECRET_ACCESS_KEY=<B2 application key>
   STORAGE_PATH=/mnt/data/tinyglow/photos
   BACKUP_PATH=/mnt/data/tinyglow/backups
   ```
2. Initialise the repository once:
   ```sh
   OFFSITE_ENV=~/servers/tinyglow/.env.offsite ~/servers/tinyglow/app/docker/backup/offsite-backup.sh --init
   ```
3. Add the cron jobs (`sudo crontab -e`; replace `<user>`):
   ```cron
   30 4 * * * OFFSITE_ENV=/home/<user>/servers/tinyglow/.env.offsite /home/<user>/servers/tinyglow/app/docker/backup/offsite-backup.sh >>/var/log/tinyglow-offsite.log 2>&1
   0 5 1 * *  OFFSITE_ENV=/home/<user>/servers/tinyglow/.env.offsite /home/<user>/servers/tinyglow/app/docker/backup/offsite-restore-test.sh >>/var/log/tinyglow-offsite.log 2>&1
   ```
   The second job restores into a scratch area each month and checks it.

`postgres/` is not copied raw; the nightly dump is the consistent copy. Your password manager
should hold: `DATA_ENCRYPTION_KEY`, `JWT_SECRET`, `RESTIC_PASSWORD` and the B2 key.

---

## Updating Tinyglow later

```sh
cd ~/servers/tinyglow
git -C app pull              # submodule: git submodule update --remote tinyglow/app (then commit in servers)
docker compose up -d --build --wait     # new migrations run automatically before the app starts
docker image prune -f
```

Other commands also run from `~/servers/tinyglow`:
- `docker compose logs -f api`
- `docker compose exec db psql -U postgres tinyglow`
- `docker compose down`

`down` never deletes data: there are no Docker volumes, and everything is in `/mnt/data/tinyglow`.

---

## Part G: Optional features (add to `.env`, then `docker compose up -d`)

| Feature | `.env` values | How to get them |
| --- | --- | --- |
| **Bot protection on sign-in** | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → Add widget, hostname `tinyglow.app` |
| **Error reporting** | `SENTRY_DSN` (server), `SENTRY_WEB_DSN` (web), `WEB_CSP_CONNECT_EXTRA=https://oNNN.ingest.<region>.sentry.io` | sentry.io → project → Client Keys. After changing `SENTRY_WEB_DSN`, run `docker compose build web && docker compose up -d web`. |
| **Enforce the security policy** | `WEB_CSP_HEADER=Content-Security-Policy` | Only after a week or two in report-only mode with no reported violations |
| **Google Photos import** | `GOOGLE_IMPORT_PROVIDER=live`, `GOOGLE_IMPORT_CLIENT_ID`, `GOOGLE_IMPORT_CLIENT_SECRET` | See G1 |
| **Sign in with Google** | `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`, `GOOGLE_CLIENT_ID=<web>,<iOS>,<Android>`, `GOOGLE_CLIENT_SECRET` | Google Cloud → Credentials. Redirect URI `https://tinyglow.app/auth/callback`. |
| **Sign in with Apple** | `GOTRUE_EXTERNAL_APPLE_ENABLED=true`, `APPLE_CLIENT_ID=<Services ID>,app.tinyglow`, `APPLE_CLIENT_SECRET` | Apple Developer → Services ID + Sign in with Apple key. The secret is an ES256 JWT you must regenerate every 6 months. Return URL `https://tinyglow.app/auth/callback`. |
| **iPhone push** | `PUSH_PROVIDER=live`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY_BASE64` | Apple Developer → Keys → APNs key (.p8). Encode with `base64 -w0 AuthKey_XXXX.p8` (on a Mac, `base64 -i … \| tr -d '\n'`). |
| **Android push** | `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_BASE64` | Firebase → Project settings → Service accounts → Generate key. Encode with `base64 -w0 service-account.json`. |
| **App Store review login** | `REVIEW_ACCOUNT_EMAIL`, `REVIEW_ACCOUNT_CODE_HASH='scrypt$…'` (keep the single quotes) | `sh app/docker/tools/review-code-hash.sh`, then follow the "Store-review family" steps in `app/packages/db/README.md` |

### G1. Google Photos import

1. In Google Cloud Console, create a project and enable the **Google Photos Picker API**.
2. Set up the OAuth consent screen:
   - External, app name Tinyglow, support email, logo;
   - Privacy and Terms URLs on `tinyglow.app`;
   - authorized domain `tinyglow.app`;
   - scope `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
3. Leave the consent screen in **Testing** and add your Google account as a test user. Tokens
   expire every 7 days in Testing.
4. Create an OAuth client of type **Web application**, with redirect URI
   **`https://tinyglow.app/api/import/google/callback`**.
5. Put the client ID and secret in `.env` with `GOOGLE_IMPORT_PROVIDER=live`, then run
   `docker compose up -d`.
6. Try Upload → Google Photos → Connect → Import. On this first real run, check:
   - imported photos keep their capture date;
   - Google strips location, as expected.
7. To go public, **publish** the consent screen and submit the sensitive scope for Google
   verification. That takes days to weeks.

---

## Part H: Phone apps (App Store and Google Play)

The phone apps use the same server. Shipping them needs your developer accounts:

1. **Apple:** an Apple Developer membership. Then:
   - Note your Team ID.
   - Create the App ID `app.tinyglow` with Associated Domains and Push Notifications.
   - Create the App Store Connect app record, and an App Store Connect API key for uploads.
2. **Google:** a Play Console account and the app `app.tinyglow` with Play App Signing.
   Copy the SHA-256 fingerprints of the app signing key and the upload key.
3. **Deep-link files.** Replace the placeholders, then redeploy (`git pull` + `up -d --build`):
   - In `app/apps/mobile-web/public/.well-known/apple-app-site-association`: `APPLE_TEAM_ID`.
   - In `assetlinks.json`: `PLAY_APP_SIGNING_SHA256` and `UPLOAD_KEY_SHA256`.
   - Check them with `curl https://tinyglow.app/.well-known/apple-app-site-association` and
     `…/assetlinks.json`.
4. **Push keys:** set the APNs and FCM values from Part G.
5. **Build and upload:** follow `app/apps/mobile-web/NATIVE.md` and
   `app/apps/mobile-web/store/release-checklist.md`, then upload to TestFlight and Play internal
   testing.
6. **Store listing:**
   - Fill in the support and marketing URLs, real Privacy and Terms text, the age rating, and the
     review account (Part G).
   - Fill in a Google test account in `store/review-notes.md`.
   - Submit the privacy label and Data Safety answers from `store/`.
   - Decide whether to declare the push token as "Device ID".
7. **Done when:** a TestFlight build and a Play internal build install, and an invite link and a
   family share link open in the app.

**Still to verify on real devices:**
- Android, end to end (the emulator crashes on the dev Mac).
- On iPhone: background album sync, Wi-Fi-only on cellular, iCloud-only originals, the "selected
  photos only" permission flow, and downloading an export.

---

## Part I: Before you invite family

- [ ] Sign-in emails arrive and don't land in spam.
- [ ] Uploads work from a phone browser over mobile data.
- [ ] The cache rule is verified (Part E, step 4).
- [ ] `https://files.tinyglow.app/` returns 404.
- [ ] Ports 6987 and 16987 are reachable only by cloudflared (firewall).
- [ ] A restore test passed, and the off-site backup ran at least once.
- [ ] `DATA_ENCRYPTION_KEY`, `JWT_SECRET`, `RESTIC_PASSWORD` and the B2 key are in your password manager.
- [ ] Real Privacy Policy and Terms pages exist.
- [ ] A share link works for a family member who has no account.

---

## Known limits right now

- **Billing:** there is no in-app purchase or Stripe yet, so you grant Plus by hand for now. Find
  the album's ID in the address bar when the album is open, or with
  `docker compose exec db psql -U postgres tinyglow -c "select id, name from babies"`. Then run:
  `docker compose run --rm migrate pnpm db:plan <babyId> plus --i-know-this-is-production`.
  Use `free` instead of `plus` to remove it. In-app purchase is a later step.
- **AI:** AI features need `OPENAI_API_KEY`. Without it the app works with AI off.
- **CI:** GitHub Actions has never run. The first push will show whether the hosted runners are
  happy.
