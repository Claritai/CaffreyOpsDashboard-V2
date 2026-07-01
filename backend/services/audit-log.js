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
  // Migration: add query_type to existing databases that predate it. ALTER TABLE
  // ADD COLUMN is a no-op-safe one-liner, but SQLite has no "IF NOT EXISTS" for
  // columns, so we check table_info first.
  const cols = db.prepare('PRAGMA table_info(audit_log)').all().map(c => c.name);
  if (!cols.includes('query_type')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN query_type TEXT');
  }
  if (!cols.includes('job_number')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN job_number TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_query_type ON audit_log(query_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_job_number ON audit_log(job_number)');
  insertStmt = db.prepare(
    'INSERT INTO audit_log (ts, event, user, ip, detail, query_type, job_number) VALUES (?, ?, ?, ?, ?, ?, ?)'
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
function record(event, { user, ip, detail, queryType, jobNumber } = {}) {
  try {
    openDb();
    let detailStr = null;
    if (detail !== undefined && detail !== null) {
      detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
      if (detailStr.length > 2048) detailStr = detailStr.slice(0, 2045) + '...';
    }
    insertStmt.run(new Date().toISOString(), event, user || null, ip || null, detailStr, queryType || null, jobNumber || null);
  } catch (e) {
    console.error('[audit] failed to record', event, e.message);
  }
}

/**
 * Query-type reporting over recorded email sends.
 *
 * `from`/`to` are optional ISO timestamps (inclusive). Returns the per-type
 * counts, the grand total, and the underlying tagged sends (capped) for export.
 */
function queryTypeReport({ from, to, queryType, jobNumber } = {}) {
  openDb();
  // Always bind both bounds so the prepared statement parameter set is stable
  // (better-sqlite3 dislikes optional named params).
  const f = from || '0000-01-01T00:00:00.000Z';
  const t = to || '9999-12-31T23:59:59.999Z';
  let where = "event = 'email_sent' AND query_type IS NOT NULL AND ts >= @from AND ts <= @to";
  const params = { from: f, to: t };
  // Optional single-type filter. Empty/absent means "all types".
  if (queryType) {
    where += ' AND query_type = @queryType';
    params.queryType = queryType;
  }
  // Optional job-number filter (case-insensitive exact match). Empty/absent = all jobs.
  if (jobNumber && String(jobNumber).trim()) {
    where += ' AND job_number = @jobNumber COLLATE NOCASE';
    params.jobNumber = String(jobNumber).trim();
  }

  const byType = db.prepare(
    `SELECT query_type AS queryType, COUNT(*) AS count
       FROM audit_log WHERE ${where}
       GROUP BY query_type ORDER BY count DESC, query_type`
  ).all(params);

  const total = byType.reduce((s, r) => s + r.count, 0);

  const rows = db.prepare(
    `SELECT ts, user, query_type AS queryType, job_number AS jobNumber, detail
       FROM audit_log WHERE ${where}
       ORDER BY ts DESC LIMIT 5000`
  ).all(params);

  // Dense per-day counts (UTC day) across the range, 0-filled, for a sparkline.
  const dayCounts = db.prepare(
    `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS count FROM audit_log WHERE ${where} GROUP BY day`
  ).all(params);
  const daily = buildDailySeries(from, to, dayCounts);

  return { from: from || null, to: to || null, queryType: queryType || null, total, byType, rows, daily };
}

/** Build a dense [{day, count}] series across a range (0-filled, capped at 60 days). */
function buildDailySeries(fromIso, toIso, dayCounts) {
  const map = new Map(dayCounts.map(r => [r.day, r.count]));
  const endDay = toIso ? new Date(toIso) : new Date();
  let startDay = fromIso ? new Date(fromIso) : new Date(endDay.getTime() - 13 * 86_400_000);
  const MAX_SPAN = 60 * 86_400_000;
  if (endDay - startDay > MAX_SPAN) startDay = new Date(endDay.getTime() - MAX_SPAN);
  const out = [];
  let d = new Date(Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate()));
  const end = new Date(Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate()));
  let guard = 0;
  while (d <= end && guard++ < 400) {
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: map.get(key) || 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** CSV escaping for one cell. */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Build a CSV (one row per tagged send) for download. */
function queryTypeReportCsv(opts) {
  const { rows } = queryTypeReport(opts);
  const header = ['Timestamp', 'User', 'Query Type', 'Job Number', 'Inbox', 'Recipients', 'Subject'];
  const lines = [header.join(',')];
  for (const r of rows) {
    let d = {};
    try { d = r.detail ? JSON.parse(r.detail) : {}; } catch { /* leave d empty */ }
    lines.push([
      r.ts, r.user, r.queryType, r.jobNumber, d.inbox,
      Array.isArray(d.recipients) ? d.recipients.join('; ') : '',
      d.subject,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

module.exports = { record, queryTypeReport, queryTypeReportCsv };
