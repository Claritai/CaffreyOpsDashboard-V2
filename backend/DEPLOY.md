# Caffrey Ops — Local Dev & Deploy

How to run the dashboard locally, what to check before pushing, and how changes
reach the live AWS box. Ops/infra details (SSH, backups, monitoring) live in
[RUNBOOK.md](./RUNBOOK.md).

---

## Architecture: local vs production

| | Local | Production (AWS) |
|---|---|---|
| Frontend | served by **Node** (`server.js`, dev-only) | served by **Caddy** from `frontend/` |
| API | Node on `127.0.0.1:3000` | Node on `127.0.0.1:3000` (Caddy proxies `/api/*`) |
| Origin | `http://localhost:3000` | `https://caffreyops.com` |
| Data | fresh local SQLCipher DBs, demo mode | real encrypted DBs, live Microsoft Graph |
| Secrets | `backend/.env.local` (throwaway) | `backend/.env` (real, on box + password manager) |

In production Caddy serves the static frontend and reverse-proxies `/api/*` to
Node. Locally there's no Caddy, so `server.js` serves the frontend itself — but
**only when `NODE_ENV !== 'production'`**, so the prod box is unaffected.

---

## 1. Local run mode

### One-time setup
```bash
# From repo root. Install deps in both packages:
( cd backend && npm install )
( cd verify  && npm install )

# Create your local env (throwaway secrets, demo mode — safe to keep):
cp backend/.env.local.example backend/.env.local

# Install the Playwright browser + its system libraries (needed once):
( cd verify && npx playwright install chromium )
sudo $(cd verify && npx playwright install-deps chromium)   # needs your sudo password
```

> **WSL / Ubuntu 26.04 note:** if `playwright install` says *"does not support
> chromium on ubuntu26.04"*, prefix it with
> `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` (the 24.04 build is
> binary-compatible). `run-local.sh` already sets this override automatically on
> Linux, so the verify harness itself needs no prefix.

### Run the dashboard locally
```bash
cd backend && npm run local      # → http://localhost:3000  (demo mode)
```
This boots Node serving both the frontend and the API on one origin. Log in via
the normal flow is bypassed for local checks — use the verify harness, or hit
the test-login endpoint, to get a demo session.

### Run it + the automated checks in one shot (the pre-push command)
```bash
./verify/run-local.sh            # or: cd verify && npm run local
```
`run-local.sh` seeds the demo config from the `*.example.json` templates, boots
the backend in demo mode, waits for it, runs the smoke + drilldown checks
against `http://localhost:3000`, then tears the backend down. **Exit 0 = safe to
push.**

---

## 2. Pre-push checklist

Before pushing dashboard changes, from the repo root:

1. `./verify/run-local.sh` — must end with `✓ all local checks passed`.
2. Eyeball the screenshots in `verify/screenshots/` if you touched UI.
3. `git status` / `git diff` — confirm no secrets, no `*.json` config with real
   data, no `.env*` staged (these are gitignored, but check).

There are no unit tests yet; the Playwright harness is the safety net. If you add
backend logic, consider adding a check to `verify/`.

---

## 3. Deploy to production

The live box (`/var/www/caffrey-ops/`) is a **git checkout of `master`**. Deploy
= pull + restart:

```bash
# SSH in (see RUNBOOK §2 for the key path)
ssh -i ~/Documents/caffrey-migration/caffrey-ops-aws.pem ubuntu@34.249.176.212

# On the box:
sudo git -C /var/www/caffrey-ops pull --ff-only
sudo systemctl restart caffrey-ops      # only needed for backend changes
sudo journalctl -u caffrey-ops -n 30 --no-pager   # confirm clean startup
```
- **Frontend-only** changes (`frontend/`) take effect on `git pull` — Caddy
  serves them directly, no restart.
- **Backend** changes need the `systemctl restart`.
- Health check from anywhere: `curl -I https://caffreyops.com/`.
- Rollback: `sudo git -C /var/www/caffrey-ops reset --hard <previous-sha>` then
  restart. (Full DR / Hostinger rollback is in RUNBOOK §7.)

> ⚠️ **`git pull` on the box requires a working GitHub credential — see §4.**
> Until that's set up, the box cannot pull and deploys will fail.

---

## 4. One-time: enable `git pull` on the box (deploy key)

The box authenticates to GitHub over SSH (`git@github.com:…`) but currently has
**no working credential**, so `git fetch`/`pull` fails with *"correct access
rights / repository exists"*. Fix it with a read-only **deploy key**:

```bash
# On the box, as root (deploys run via sudo, so the key must be root's):
sudo ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N "" -C "caffrey-ops-deploy"
sudo cat /root/.ssh/id_ed25519.pub      # copy this
```
Then in GitHub: **repo → Settings → Deploy keys → Add deploy key** → paste the
public key, title `caffrey-ops-box`, leave **Allow write access unchecked**
(pull is read-only). Verify on the box:
```bash
sudo ssh -T git@github.com                       # accept host key, expect a greeting
sudo git -C /var/www/caffrey-ops fetch origin    # should succeed now
```

---

## 5. One-time: reconcile box drift before the first pull

The box has uncommitted local edits that are now captured in the repo
(`backend/scripts/backup.sh` — the S3-upload block) plus some stray files. Before
the first `git pull`, clear them so the pull is clean:

```bash
# On the box — discard the now-redundant local backup.sh edit (identical to repo):
sudo git -C /var/www/caffrey-ops checkout -- backend/scripts/backup.sh
# Remove leftover backup/working files (NOT the live .env):
sudo rm -f /var/www/caffrey-ops/backend/.env.bak-* \
           /var/www/caffrey-ops/backend/.env.orig-redirect \
           /var/www/caffrey-ops/backend/scripts/backup.sh.bak-*
sudo git -C /var/www/caffrey-ops status   # should be clean
```
Do **not** touch `/var/www/caffrey-ops/backend/.env` — that's the live secrets
file and is gitignored.
