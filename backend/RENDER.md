# Deploying Caffrey Ops on Render

This runs as **one web service**: Node serves the API *and* the static frontend
on a single origin (no Caddy, no CORS). The code changes that make this work are
already in this version (binds `0.0.0.0`, serves the frontend in production,
creates `backend/data/` on boot, Node pinned to 20–22).

## 1. Generate the three secrets

```bash
# SESSION_SECRET and CSRF_SECRET — any long random string
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# DB_ENCRYPTION_KEY — must be EXACTLY 64 hex chars. Save it in a password
# manager; if you lose it the encrypted databases cannot be opened.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Create the service

**Option A — Blueprint (uses `render.yaml`):**
Render → New + → Blueprint → pick this repo → Apply. Then fill in the env vars
it prompts for.

**Option B — Manual:** Render → New + → Web Service → connect the repo, then set:
- Root Directory: `backend`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/`
- Add a Disk: mount path `/opt/render/project/src/backend/data`, size 1 GB
  (keeps logins + hypercare history across deploys; needs a paid instance).

## 3. Environment variables

Set these in the dashboard (Render injects `PORT` itself — do not set it):

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | from step 1 |
| `CSRF_SECRET` | from step 1 |
| `DB_ENCRYPTION_KEY` | 64-hex from step 1 |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | from Azure |
| `AZURE_REDIRECT_URI` | `https://<your-service>.onrender.com/api/auth/callback` |
| `ALLOWED_USERS` | comma-separated allow-list |
| `INBOX_*` | the six shared-mailbox addresses |
| `PRIORITY_CLIENTS` | comma-separated domains |
| `TELEGRAM_*` / `TEAMS_WEBHOOK_URL` | optional, omit to disable |

## 4. Point Azure at the Render URL

In the Azure App Registration → Authentication → add a **Web** redirect URI that
exactly matches `AZURE_REDIRECT_URI` above. Microsoft rejects the login if it
doesn't match character-for-character (https, no trailing slash).

You only know the final `*.onrender.com` URL after the first deploy, so: deploy
once, copy the URL, set `AZURE_REDIRECT_URI` + register it in Azure, redeploy.

## Notes / gotchas
- **No disk = ephemeral.** Without the persistent disk, every deploy wipes
  `sessions.db` and `hypercare.db`: users re-login and hypercare history resets.
- **Free instance sleeps** after ~15 min idle; first hit afterwards is slow.
  Use `starter`+ to keep it warm.
- **Demo mode** works without any Azure/Graph setup — useful for a first smoke
  test before wiring up Microsoft 365.
- The single-VM **Caddy** path still works unchanged; set `SERVE_FRONTEND=false`
  there if you want Caddy (not Node) to serve the static files.
