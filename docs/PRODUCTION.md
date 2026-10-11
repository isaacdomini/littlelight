# Putting Tinyglow into production

This guide takes Tinyglow from this repo to a running production server. It assumes:
- **Server layout:** the server is laid out like the `servers` repo, with one folder per app and
  `docker compose up -d` run inside that folder.
- **Data:** all data lives under `/mnt/data/tinyglow/`.
- **Cloudflare:** already set up, with `tinyglow.app` → port **6987** and `files.tinyglow.app` →
  port **16987**.

Work through the parts in order. Parts A–F get the web app live. Parts G–I are optional features
and the phone apps, and you can do them later. Part J is the routine for spotting and stopping
free-tier abuse once families start using it.

---

## Part A: Accounts and values to collect first

You need these before the first start:

| What | Why | Where |
| --- | --- | --- |
| **Domain `tinyglow.app`** | The app and photo hosts | Register it now. It was free on 2026-10-10. No trademark search was done. |
| **Email sending (SMTP)** | Sign-in codes and invite emails. Without it nobody can sign in. | [Postmark](https://postmarkapp.com) or [Resend](https://resend.com), with a verified sender such as `noreply@tinyglow.app` |
| **OpenAI API key** | AI descriptions, search and chat (paid tier only) | platform.openai.com → API keys. Optional: without it the app runs with AI turned off. |
| **Off-site backup bucket** | A copy of photos and database dumps off the server | Backblaze B2 (or any S3), with an application key scoped to one bucket |
| **Support mailbox `support@tinyglow.app`** | Suspended accounts are told "This account has been suspended. Contact support@tinyglow.app." (the address is built into the app), and a suspended person who wants their account deleted has to write there (Part J). Mail sent there must reach you. | A mailbox or a forwarding alias at your mail host for `tinyglow.app`. Send it a test message before launch. |
| **Cloudflare Turnstile widget** (strongly recommended) | Bot protection on sign-in. Without it, nothing but the per-network cap on new families slows down scripted accounts (Part C2). | Cloudflare → Turnstile → Add widget, hostname `tinyglow.app`. You get a site key and a secret key. |

Optional, any time later: Sentry, Google Photos import, Apple and Google sign-in, and the push
notification keys. See Part G.

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
This also keeps the per-network limits honest: they trust the client address Cloudflare sends
(Part J, "The per-network checks need the tunnel to be the only way in").

### C2. Bot protection (strongly recommended)

```dotenv
TURNSTILE_SITE_KEY=<site key>       # Cloudflare → Turnstile → your tinyglow.app widget
TURNSTILE_SECRET_KEY=<secret key>
```

After 3 sign-in code requests from one network in an hour, the sign-in form asks for a Turnstile
challenge. With the keys empty this check is off, and scripted accounts are slowed down only by
the per-network cap on new families (Part J). The app still starts, but the api logs this
warning once at every start in production:

```
turnstile is off: set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (recommended in production)
```

Check for it after the first start (Part E) with
`docker compose logs api | grep -i "turnstile is off"`: no output means Turnstile is on.

### C3. AI (recommended)

```dotenv
OPENAI_API_KEY=sk-...             # empty = AI features off
# Defaults are already right; change only if needed:
# VISION_MODEL=gpt-6-luna  CHAT_MODEL=gpt-6-luna  EMBED_MODEL=text-embedding-3-small  EMBED_DIMS=1024
# AI_BABY_MONTHLY_BUDGET_USD=3     # per-album monthly spend cap
```

Free-tier photos are never sent to a model, whatever you set here.

### C4. Leave these as they are (defaults are correct)

`NODE_ENV`, `API_HOST` and `API_PORT` are fixed in compose. The S3 endpoint, region and path
style, all AI and search tuning, and the backup retention (35 days at 03:00) also have the right
defaults. So do the family-start safeguards (`FAMILIES_PER_IP_PER_DAY=5`, `BLOCK_DISPOSABLE_EMAIL=true`,
empty `EMAIL_DOMAIN_DENYLIST` and `EMAIL_DOMAIN_ALLOWLIST`); Part G says when to change them. The
cap of 200 photos waiting for approval per guest is a database setting, not a `.env` value
(Part J).

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
| **Bot protection on sign-in (strongly recommended)** | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Not really optional: see Part C2. Cloudflare → Turnstile → Add widget, hostname `tinyglow.app`. Without the keys the api logs `turnstile is off: …` at every start in production. |
| **New families per network** | `FAMILIES_PER_IP_PER_DAY` (default `5`, range 1–100000) | New families (an account creating its first album) allowed from one network (IP address) per rolling 24 hours. Signing in, joining a family as a guest and adding more albums to an existing family never count, so the usual "one parent starts the family and invites the rest" flow never hits it. Raise it if a support email shows people behind one connection (an office, a campus) being refused ("Too many new families were started from your network today"). |
| **Throwaway email domains** | `BLOCK_DISPOSABLE_EMAIL` (default `true`), `EMAIL_DOMAIN_DENYLIST`, `EMAIL_DOMAIN_ALLOWLIST` (comma lists) | Addresses on about 3,500 disposable-mail domains can't start a family ("Temporary or disposable email addresses can't start a family…"); they can still sign in and join a family as a guest. Add a domain to refuse with the deny list. If a real provider is wrongly blocked, put it on the allow list: no code change, just `docker compose up -d api`. Apple "Hide My Email" addresses are never blocked. The list itself is updated by a code change (`app/apps/api/src/auth/disposable/README.md`). |
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
- [ ] Turnstile keys are set: `docker compose logs api | grep -i "turnstile is off"` prints nothing.
- [ ] A test message to `support@tinyglow.app` reaches you (suspended people write there, also to
      have their account deleted: Part J).
- [ ] Uploads work from a phone browser over mobile data.
- [ ] The cache rule is verified (Part E, step 4).
- [ ] `https://files.tinyglow.app/` returns 404.
- [ ] Ports 6987 and 16987 are reachable only by cloudflared (firewall).
- [ ] A restore test passed, and the off-site backup ran at least once.
- [ ] `DATA_ENCRYPTION_KEY`, `JWT_SECRET`, `RESTIC_PASSWORD` and the B2 key are in your password manager.
- [ ] Real Privacy Policy and Terms pages exist.
- [ ] A share link works for a family member who has no account.

---

## Part J: Watching for free-tier abuse

### How the free limit works

The free tier is **1,000 photos per family**, not per album and not per person. A family is a
set of albums (twins, siblings) with the same parents. Every free album of a family draws from
that one pool, whoever created it, so making a second album does not give anyone more space:
- **One family per parent.** An account is a parent (admin) in at most one family. Its first
  album starts its family; every later album it creates joins that same family. To be a parent
  of a second family, a person needs a second account, and that account has to pass the checks
  below. Making someone a co-parent (accepting an admin invite, or being promoted to admin) is
  refused when that account is already a parent in another family: "This account is already a
  parent in another family. Use a different account to be a parent here, or join as a guest."
- **The founder stays with the family.** The account that started a family (created its first
  album) stays tied to it as long as the family has a live album (one that isn't in the trash).
  Adding a co-parent and then leaving, stepping down to guest or being removed does not free the
  founder to start a new family: it can't hand the family to someone else and start over. A new
  family needs a separate account, and that account has to pass the checks below.
- **Guests are free.** An account can be a guest (contributor) in any number of families. Being
  a guest gives nothing and costs nothing: a guest's photos count against **that** family's
  limit, and only once a parent approves them.
- **Which photos count:** approved photos in the family's free albums that aren't in the trash.
  Photos waiting for approval don't count. Approving a photo into a full family is refused with
  the "full" message, so a parent makes room first. Photos in the trash don't count, so moving
  photos to the trash frees room at once. An approved photo restored from the trash counts
  again, and that restore is refused when the family is full.
- **Pending photos are capped:** at most **200 photos waiting for approval per guest per family**,
  so a guest cannot fill the server through the approval queue. The guest then sees "You have
  200 photos waiting for approval in this family (the most is 200). Wait for a parent to review
  them before adding more." The cap applies to Plus families too (it protects storage, not the
  free tier). To change it, see "Changing the pending-photo cap" below.
- **The family stays with its albums.** If a parent leaves an album, is removed, stops being an
  admin, or deletes their account, the album stays in its family and keeps drawing from the
  same pool.
- **Plus albums don't count.** Plus is per album: granting Plus to one album (`db:plan`, below)
  takes all its photos out of the family's pool, which frees room in the family's other free
  albums.
- **Albums in the trash don't count** toward the pool either.
- **Already over 1,000?** (photos from before this limit existed, or two sets of albums that the
  upgrade merged into one family because they shared a parent) Nothing is deleted. The family
  just accepts no new approved photos until it is below 1,000 again (photos moved to the trash)
  or albums become Plus.

Parents see "Your family's free photos: 640 of 1,000 (across 2 albums)" and guests "This
family's free photos: 640 of 1,000". When an upload, approval, restore or import is refused:
"Your family's free albums are full: free albums hold 1,000 photos per family. Upgrade to Plus or
delete photos to add more." The limit and the pending cap are enforced by the database for every
way a photo can arrive (upload, Google Photos import, iPhone album sync, approval, restore).

Starting a second family is made harder on purpose. **The checks run when an account starts a
family** (creates its first album), never at sign-in: anyone can sign in with any address and
join a family as a guest.
- **One inbox, one family.** `Maria.Rossi+baby@gmail.com`, `mariarossi@gmail.com` and
  `maria.rossi@googlemail.com` are the same inbox. Each can have an account, but only one of them
  can be a parent: starting a family is refused when another account for the same inbox already
  has one, with a masked hint ("Another Tinyglow account for this inbox (m•••@gmail.com) already
  has a family. Sign in with that account to add an album, or use a different email."). (Dots
  are ignored for Gmail only; `+tags` are ignored for every domain.)
- **Throwaway email domains** can't start a family (`BLOCK_DISPOSABLE_EMAIL`, Part G). They can
  still sign in and join a family as a guest.
- **At most `FAMILIES_PER_IP_PER_DAY` new families per network per day** (default 5, counted over
  the last 24 hours). This is a hard cap: once a network has reached it, its next family start is
  refused until the oldest one is 24 hours old, even when several start at the same moment. Guests
  and later albums of an existing family never count.
- **Turnstile** on the sign-in form (Part C2).

None of these compares photos between accounts or families: no one's photos are ever matched
against anyone else's.

**The per-network checks need the tunnel to be the only way in.** "Network" means the address in
the `CF-Connecting-IP` header, which Cloudflare sets on every request it forwards. The api takes
the client's address from that header, so the family-start cap, the sign-in throttles and the
Turnstile trigger (Part C2), and the network column of the abuse report (sections 1 and 4 below)
all rely on it. Anyone who can reach port 6987 or 16987 without going through Cloudflare can write
any address they like into that header and get a fresh "network" on every request. Keep the
ports bound to `127.0.0.1`, or firewalled so only cloudflared can reach them, as set up in Part C
("Which bind address?"). Check after any change to the server's network or firewall:

```sh
ss -ltn | grep -E ':(6987|16987) '   # expect 127.0.0.1 (or only your LAN IP, firewalled)
```

### Changing the pending-photo cap

The cap of 200 photos waiting for approval per guest per family is a database setting, not a
`.env` value, so the database trigger and the api always agree. From `~/servers/tinyglow`:

```sh
docker compose exec db psql -U postgres tinyglow -c "alter database tinyglow set app.pending_photo_limit = '500'"
docker compose restart api worker        # their open database connections pick up the new value
docker compose exec db psql -U postgres tinyglow -c "select pending_photo_limit()"   # 500
```

Back to the default (200): `alter database tinyglow reset app.pending_photo_limit`, then the same
restart. Photos already waiting above a lowered cap stay; the guest just can't add more until the
queue is below it.

### Weekly check: the abuse report

Run from `~/servers/tinyglow`:

```sh
docker compose run --rm migrate pnpm admin:abuse-report               # last 7 days
docker compose run --rm migrate pnpm admin:abuse-report --days 30     # up to 30 (family-start records are kept 30 days)
docker compose run --rm migrate pnpm admin:abuse-report --limit 50    # longer "top storage" lists (default 20)
docker compose run --rm migrate pnpm admin:abuse-report --json        # the same, as JSON for scripts
```

The report only reads; it never changes anything. It prints IDs, counts and sizes, never email
addresses or IP addresses. Everything is per family. Its six sections:

1. **Family starts per network.** Networks that started 3 or more families in the window, most
   first, with the first and last start. A network is shown as the first 12 characters of a
   keyed hash of its IP address (the IP itself is never stored).
2. **Families near or over the limit.** Families whose free pool holds 800 approved photos or
   more (80 %), fullest first: the number of parents, free albums, approved photos, photos
   waiting for approval, size of the originals and the percentage. `OVER` marks families above
   1,000 (photos from before this limit existed, or albums merged into one family by the
   upgrade).
3. **Top storage.** The albums (with their family, plan, approved and pending photos, and whether
   they are in the trash) and the families (parents, albums, photos) using the most space, Plus
   and trashed albums included (trashed albums use space until they are purged). Sizes are the
   originals; thumbnails and previews add roughly 10–15 %.
4. **Recent family starts.** Families started in the window, by whom and from which app (web or
   native), with flags: `plus_tag` (the address had a `+tag`), `dots_folded` (Gmail dots were
   removed), `canonical_dup` (another account shares the founder's inbox; it may be a guest
   somewhere, which is allowed), `suspended` (a parent of the family is suspended). `purged`
   means the family has since been deleted, `deleted` that the founder's account has.
5. **Pending queues.** Guests holding at least half of the pending cap (100 of 200 by default) in
   one family: the family, the guest and how many of their photos wait for approval. A long
   queue is usually a busy grandparent and a parent who hasn't reviewed yet; it is also the only
   intake that isn't metered by the free limit, which is why it is listed.
6. **Canonical-inbox clusters.** Inboxes that have two or more live accounts (for example
   `mariarossi@gmail.com` and `maria.rossi+baby@gmail.com`), up to `--limit`: how many accounts,
   how many of them are a parent, in how many families, when the first and last were created,
   and the account IDs, oldest first. Only account IDs are printed; the inbox address itself is
   never shown, not even with `--show-emails` (which adds each account's own address). Several
   accounts with **0 or 1** parent is normal: the same person joined someone's family as a guest
   with a different spelling of their address. Two or more parents in two or more families means
   one inbox is a parent in several families. Starting a second family that way is refused, so
   this comes from accounts that were parents before this limit existed, or from a second
   account of the inbox accepting a co-parent invite in another family.

**When to act.** A full family, by itself, is normal: it is a family that likes photos, and the
right answer is Plus, not a suspension. Look closer when several signals line up:
- a network in section 1 with many family starts, **and** starts from the same days in section 4
  with `plus_tag`, `dots_folded` or `canonical_dup`, whose families then show up in section 2 or
  3;
- one account that is a guest in many families, especially families started from the same
  network in section 1 (one person running several families and uploading through guest roles).
  Grandparents and nannies can be guests in a few families; many more is unusual:
  ```sh
  docker compose exec db psql -U postgres tinyglow -c "select m.user_id, count(distinct b.family_id) as families from baby_members m join babies b on b.id = m.baby_id where m.role = 'contributor' and b.deleted_at is null group by m.user_id having count(distinct b.family_id) >= 5 order by 2 desc"
  ```
- the same guests at the top of section 5 week after week in different families;
- one family or album in section 3 far above everyone else;
- an inbox in section 6 that is a parent in several families, especially when those families
  also appear in section 2 or 3.

A busy network on its own (a school, an office, a phone carrier) is not abuse. When you are not
sure, do nothing and check again next week.

**Seeing who it is.** Add `--show-emails` to add an `emails` column to sections 2–6: the
parents' addresses in sections 2 and 3, the founder's in section 4, the guest's in section 5 and
each account's own address in section 6. Section 1 never shows addresses.

```sh
docker compose run --rm migrate pnpm admin:abuse-report --show-emails
```

The output then contains personal data, and the report says so. Read it on the server only:
don't paste it into tickets or chats, and never save it under `~/servers` (that repo is public).
To look up one account instead:

```sh
docker compose exec db psql -U postgres tinyglow -c "select id, email, created_at from auth.users where id = '<userId>'"
docker compose exec db psql -U postgres tinyglow -c "select id from auth.users where email = lower('<address>')"
```

### Taking action

**Suspend an account** (it keeps its data):

```sh
docker compose run --rm migrate pnpm admin:suspend <userId> --i-know-this-is-production
docker compose run --rm migrate pnpm admin:suspend <userId> --reason other --i-know-this-is-production   # reason: abuse (default) or other
```

At once, every device of that account is signed out and every request is refused with "This
account has been suspended. Contact support@tinyglow.app." Signing in again is refused with the
same message, and sign-in codes for that address are no longer sent. Its family, albums and
photos, the other parents and guests of those albums, and their family share links are **not**
touched, so a co-parent keeps full access. The suspension is recorded in the audit log.

**Lift it** (for example after a reply to the support mailbox):

```sh
docker compose run --rm migrate pnpm admin:suspend <userId> --lift --i-know-this-is-production
```

The person signs in again as usual.

**A suspended person who wants their account deleted** has to email support@tinyglow.app: they
can't open the app, so they can't use Settings → Delete account themselves. Check that the mail
comes from the account's own address (the `auth.users` lookup above), lift the suspension, and
reply that they can now delete it in the app (Settings → Delete account). If it isn't deleted
within a few days, suspend it again. Don't delete it for them by hand (see below).

**Give a family more room** instead: grant Plus to an album (see "Billing" under Known limits).
This is also how you settle a support request from a family with a real need.

**Don't delete accounts by hand** (for example `delete from auth.users`): it breaks the "every
album keeps an admin" rule and leaves photos behind in storage. Deletion goes through the app's
own account deletion only.

---

## Known limits right now

- **Billing:** there is no in-app purchase or Stripe yet, so you grant Plus by hand for now. Find
  the album's ID in the address bar when the album is open, or with
  `docker compose exec db psql -U postgres tinyglow -c "select id, name from babies"`. Then run:
  `docker compose run --rm migrate pnpm db:plan <babyId> plus --i-know-this-is-production`.
  Use `free` instead of `plus` to remove it. In-app purchase is a later step. A Plus album
  leaves its family's free pool (Part J), so this is also how you give a family more room.
- **AI:** AI features need `OPENAI_API_KEY`. Without it the app works with AI off.
- **CI:** GitHub Actions has never run. The first push will show whether the hosted runners are
  happy.
