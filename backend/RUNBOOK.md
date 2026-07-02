# Caffrey Ops Dashboard — AWS Runbook

**Live since:** 2026-06-06 (migrated from Hostinger VPS to AWS EC2)
**URL:** https://caffreyops.com
**Owner:** Sean Laffey

> **Deploying code changes?** See [DEPLOY.md](./DEPLOY.md) for local dev, the
> pre-push checklist, and the prod deploy (`git pull` + restart). This runbook
> covers infra/ops only.

---

## 1. What runs where

| Thing | Value |
|---|---|
| Host | AWS EC2 `i-0faca63a2d36e9c93` (t3.small, Ubuntu 24.04), region `eu-west-1` |
| Public IP | `34.249.176.212` (Elastic IP — stays fixed across reboots) |
| App | Node.js (`server.js`) as systemd unit `caffrey-ops`, listening on `127.0.0.1:3000` |
| Web server | Caddy (auto-HTTPS via Let's Encrypt), config `/etc/caddy/Caddyfile` |
| App dir | `/var/www/caffrey-ops/` (backend in `backend/`, static in `frontend/`) |
| Databases | `/var/www/caffrey-ops/backend/data/` — `hypercare.db`, `sessions.db` (SQLCipher-encrypted) |
| Secrets | `/var/www/caffrey-ops/backend/.env` (root:root, mode 600) — holds DB key + Azure secret |
| Service user | `www-data` |

## 2. SSH in

```bash
ssh -i ~/Documents/caffrey-migration/caffrey-ops-aws.pem ubuntu@34.249.176.212
```
(Private key also backed up in Sean's password manager. SSH is locked to Sean's IP in the security group `caffrey-ops-sg` — if you get a timeout, your home IP changed; update the SG inbound rule for port 22.)

## 3. Common operations (run on the box, with sudo)

```bash
# Status / restart / stop / start the app
sudo systemctl status caffrey-ops
sudo systemctl restart caffrey-ops
sudo systemctl stop caffrey-ops
sudo systemctl start caffrey-ops

# Live app logs
sudo journalctl -u caffrey-ops -f

# Reload Caddy after editing /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 50 --no-pager

# Check what's listening
sudo ss -tlnp | grep -E ':(80|443|3000)'
```

## 4. Backups

- **Nightly:** systemd timer `caffrey-ops-backup.timer` runs `backend/scripts/backup.sh` at **03:00 UTC**.
  Writes an encrypted snapshot of `hypercare.db` + config JSON to `/var/backups/caffrey-ops/` (keeps last 7)
  **and uploads to S3** `s3://caffrey-ops-backups-906ffb76/` (instance-role auth, no stored keys).
- **S3 retention:** lifecycle rule → Glacier Instant Retrieval at 30 days, deleted at 365 days.
- **NOT backed up:** `.env` (and the DB encryption key) — these live ONLY in Sean's password manager. Without the key, backups are unrecoverable. `sessions.db` is also skipped (ephemeral).
- **EBS snapshots:** DLM policy `policy-0f55283c10f3034fd` takes a full-disk snapshot daily at 02:00 UTC, 7-day retention.

```bash
# Run a backup on demand
sudo systemctl start caffrey-ops-backup.service
# List S3 backups
aws s3 ls s3://caffrey-ops-backups-906ffb76/ --region eu-west-1
```

### Restore outline
See `backend/scripts/BACKUP.md` on the box. In short: stop the app, untar a snapshot, use `scripts/lib/copy-db.js` to write it back to an encrypted `data/hypercare.db` using `DB_ENCRYPTION_KEY` from `.env`, restart. The DB open sequence is `pragma cipher='sqlcipher'` then `pragma key="x'<64-hex key>'"`.

## 5. Monitoring

- **CloudWatch alarms** → SNS topic `caffrey-ops-alarms` → email `sean.n.laffey@gmail.com`:
  - `caffrey-ops-cpu-high` — CPU > 80% for 10 min
  - `caffrey-ops-status-check-failed` — instance/system health check fails
- Manual health check from anywhere:
  ```bash
  curl -I https://caffreyops.com/
  ```

## 6. TLS / DNS

- Caddy obtains & renews the Let's Encrypt cert for `caffreyops.com` automatically.
- DNS is managed in **Hostinger hPanel** (registrar/nameservers unchanged). The A record for
  `caffreyops.com` points to `34.249.176.212`. TTL 300.

## 7. Rollback (only meaningful during the 48h overlap while Hostinger is intact)

1. On Hostinger (`ssh -i ~/.ssh/caffrey_hostinger root@187.77.177.107`): `systemctl start caffrey-ops`
2. In hPanel, point the `caffreyops.com` A record back to `187.77.177.107`
3. Stop the AWS app: `sudo systemctl stop caffrey-ops`
Note: any data written on AWS after cutover would not be on Hostinger.

## 8. Outstanding / decommission (target T+7 ≈ 2026-06-13)

- [ ] After 7 clean days: take a final Hostinger tarball → `s3://caffrey-ops-backups-906ffb76/hostinger-final/`, then cancel the Hostinger plan
- [ ] Remove the `aws-test` DNS record in hPanel
- [ ] Remove the `https://aws-test.caffreyops.com/api/auth/callback` redirect URI from Azure AD
- [ ] Remove the migration SSH key from Hostinger (`~/.ssh/caffrey_hostinger.pub` entry in root's authorized_keys)
- [ ] (Optional) delete/rotate the `claude-code-migration` IAM user
- Azure client secret expires **May 2027** — rotate by March 2027.
