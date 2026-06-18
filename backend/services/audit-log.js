/**
 * Append-only identity audit log.
 *
 * Separate concern from [[hypercare-store]]'s `activity` table (which tracks
 * load mutations only). This one records identity events: logins, failed
 * logins, logouts, access-denied, settings changes, and email sends.
 *
 * Lives in the same encrypted hypercare.db file (shares DB_ENCRYPTION_KEY)
 * so backups and at-rest protection are one decision, not two. The module
 * exports only `record(event, fields, req)` — there is no update or delete
 * path. Reads are not exposed via any unauthenticated route.
 *
 * GDPR: rows contain personal data (email addresses, recipients, subjects).
 * Retention policy is Phase 3 work — until then, the table grows unbounded.
 * Email subjects are logged for investigatability; if Caffrey's DP advisor
 * objects, strip the `subject` field from auditEmailSend() before deploy.
 */

const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');

const DB_PATH = path.join(__dirname, '..', 'data', 'hypercare.db');

let db = null;
let insertStmt = null;

function openDb() {
  if (db) return db;
  const key = process.env.DB_ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('DB_ENCRYPTION_KEY missing or not 64 hex chars — refusing to open audit log');
  }
  db = new Database(DB_PATH);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${key}'"`);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     TEXT NOT NULL,
      event  TEXT NOT NULL,
      user   TEXT,
      ip     TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event);
  `);
  insertStmt = db.prepare(
    'INSERT INTO audit_log (ts, event, user, ip, detail) VALUES (?, ?, ?, ?, ?)'
  );
  return db;
}

/**
 * Record one audit event. Never throws — audit failures must not break the
 * caller's primary flow (we log to stderr and move on).
 *
 * @param {string} event - short identifier, e.g. 'login_ok', 'email_sent'
 * @param {object} fields
 * @param {string} [fields.user]   - acting user's email (or attempted email on failed login)
 * @param {string} [fields.ip]     - source IP (typically req.ip; trust proxy is set)
 * @param {object|string} [fields.detail] - extra context (object is JSON-stringified, capped at 2KB)
 */
function record(event, { user, ip, detail } = {}) {
  try {
    openDb();
    let detailStr = null;
    if (detail !== undefined && detail !== null) {
      detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
      if (detailStr.length > 2048) detailStr = detailStr.slice(0, 2045) + '...';
    }
    insertStmt.run(new Date().toISOString(), event, user || null, ip || null, detailStr);
  } catch (e) {
    console.error('[audit] failed to record', event, e.message);
  }
}

module.exports = { record };
