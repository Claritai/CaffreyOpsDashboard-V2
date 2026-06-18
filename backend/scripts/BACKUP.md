# Caffrey Ops — Backup & Restore

## How it runs

A systemd timer (`caffrey-ops-backup.timer`) fires `backup.sh` nightly at
03:00 as `www-data`. The companion `.service` unit pulls in `backend/.env`
via `EnvironmentFile=` so `DB_ENCRYPTION_KEY` is available — www-data can't
read `.env` directly (mode 600 root), so a plain cron job would silently
fail to open the encrypted DB.

```
systemctl status  caffrey-ops-backup.timer        # next/last fire
systemctl list-timers caffrey-ops-backup.timer    # schedule
systemctl start   caffrey-ops-backup.service      # one-off run
journalctl -u caffrey-ops-backup.service          # logs
```

## What's in each tarball

`/var/backups/caffrey-ops/caffrey-ops-YYYYMMDD-HHMMSS.tgz` (mode 600, root):

- `hypercare.db` — encrypted snapshot of the live DB (via SQLite backup API,
  consistent under writes). Includes the `audit_log` table.
- `hypercare.json`, `top-clients.json`, `categories.json`, `sla.json` —
  live runtime config.

Rotation: last 7 snapshots kept; older ones deleted on each run.

## What's NOT backed up — and why

- **`backend/.env`** (and `DB_ENCRYPTION_KEY`). Without the key the
  encrypted DB is unrecoverable, so the key MUST be backed up
  out-of-band (password manager). Keeping the key out of the tarball
  means a leaked backup file is still opaque to whoever finds it.
- **`sessions.db`** — ephemeral, no value preserving across restore.
- **`.example.json`** files — live in git.
- **`node_modules`** — restored via `npm install`.

## Restore

1. Restore the app code: `git clone` the repo to `/var/www/caffrey-ops`,
   `cd backend && npm install`.
2. Recreate `backend/.env` from your out-of-band copy. Critically:
   `DB_ENCRYPTION_KEY` MUST match the one the backup was taken with.
3. Pick a tarball and extract into a scratch dir:
   ```
   mkdir -p /tmp/restore && tar -xzf /var/backups/caffrey-ops/caffrey-ops-<ts>.tgz -C /tmp/restore
   ```
4. Move pieces into place (with the service stopped):
   ```
   systemctl stop caffrey-ops
   cp /tmp/restore/hypercare.db   /var/www/caffrey-ops/backend/data/
   cp /tmp/restore/*.json         /var/www/caffrey-ops/backend/config/
   chown www-data:www-data /var/www/caffrey-ops/backend/data/hypercare.db /var/www/caffrey-ops/backend/config/*.json
   chmod 640               /var/www/caffrey-ops/backend/data/hypercare.db /var/www/caffrey-ops/backend/config/*.json
   rm -f /var/www/caffrey-ops/backend/data/hypercare.db-wal /var/www/caffrey-ops/backend/data/hypercare.db-shm
   systemctl start caffrey-ops
   ```
5. Sanity-check: `journalctl -u caffrey-ops -n 20` — no errors at boot.
   `curl -i http://127.0.0.1:3000/api/hypercare/loads` should return `401`
   (proves the encrypted DB opened cleanly under the new key).

## Off-host extension

The script writes locally; for off-host storage, add an `rsync` /
`aws s3 cp` / `rclone copy` line at the end of `backup.sh` pointing at
encrypted destination storage. GDPR: backups contain personal data —
destination must be access-controlled, encrypted at rest, and covered
by the same retention policy (Phase 3).
