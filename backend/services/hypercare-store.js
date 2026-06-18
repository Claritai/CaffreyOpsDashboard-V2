/**
 * SQLite-backed store for hypercare loads, notes, and activity.
 *
 * Loads live here until resolved; notes and activity are append-only.
 * Single shared DB file under backend/data/hypercare.db — survives restarts
 * (unlike the in-memory session store).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3-multiple-ciphers');

const DB_PATH = path.join(__dirname, '..', 'data', 'hypercare.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const dbKey = process.env.DB_ENCRYPTION_KEY;
if (!dbKey || !/^[0-9a-fA-F]{64}$/.test(dbKey)) {
  throw new Error('DB_ENCRYPTION_KEY missing or not 64 hex chars — refusing to open hypercare.db');
}

const db = new Database(DB_PATH);
db.pragma(`cipher='sqlcipher'`);
db.pragma(`key="x'${dbKey}'"`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS loads (
    id              TEXT PRIMARY KEY,
    booking_ref     TEXT NOT NULL,
    client          TEXT NOT NULL,
    client_reason   TEXT,
    route_origin    TEXT,
    route_dest      TEXT,
    cargo_value     INTEGER,
    subject         TEXT,
    from_address    TEXT,
    received_at     TEXT NOT NULL,
    last_action_at  TEXT,
    last_action_by  TEXT,
    workflow_state  TEXT NOT NULL DEFAULT 'monitoring',
    claimed_by      TEXT,
    escalated_to    TEXT,
    escalated_at    TEXT,
    resolved_at     TEXT,
    resolved_by     TEXT,
    thread_url      TEXT
  );

  CREATE TABLE IF NOT EXISTS notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    load_id     TEXT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
    author      TEXT NOT NULL,
    text        TEXT NOT NULL,
    timestamp   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    actor       TEXT,
    action      TEXT NOT NULL,
    load_id     TEXT,
    booking_ref TEXT,
    detail      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_notes_load ON notes(load_id);
  CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(timestamp);
`);

// ── Reads ────────────────────────────────────────────────────────────────────

const selectLoads = db.prepare(`SELECT * FROM loads ORDER BY received_at DESC`);
const selectNotes = db.prepare(`SELECT author, text, timestamp FROM notes WHERE load_id = ? ORDER BY id ASC`);

function listLoads() {
  return selectLoads.all().map(rowToLoad);
}

function rowToLoad(r) {
  return {
    id: r.id,
    bookingRef: r.booking_ref,
    client: r.client,
    clientReason: r.client_reason,
    route: { origin: r.route_origin, destination: r.route_dest },
    cargoValue: r.cargo_value,
    subject: r.subject,
    fromAddress: r.from_address,
    receivedAt: r.received_at,
    lastActionAt: r.last_action_at,
    lastActionBy: r.last_action_by,
    workflowState: r.workflow_state,
    claimedBy: r.claimed_by,
    escalatedTo: r.escalated_to,
    escalatedAt: r.escalated_at,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    notes: selectNotes.all(r.id),
    threadUrl: r.thread_url,
  };
}

const selectActivityToday = db.prepare(`
  SELECT timestamp, actor, action, load_id, booking_ref, detail
  FROM activity
  WHERE timestamp >= ?
  ORDER BY timestamp DESC
  LIMIT 200
`);

function listActivityToday() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return selectActivityToday.all(startOfDay.toISOString());
}

// ── Writes ───────────────────────────────────────────────────────────────────

const insertLoad = db.prepare(`
  INSERT INTO loads (id, booking_ref, client, client_reason, route_origin, route_dest,
                     cargo_value, subject, from_address, received_at, thread_url)
  VALUES (@id, @bookingRef, @client, @clientReason, @routeOrigin, @routeDest,
          @cargoValue, @subject, @fromAddress, @receivedAt, @threadUrl)
`);

function createLoad(load, actor) {
  insertLoad.run({
    id: load.id,
    bookingRef: load.bookingRef,
    client: load.client,
    clientReason: load.clientReason ?? null,
    routeOrigin: load.route?.origin ?? null,
    routeDest: load.route?.destination ?? null,
    cargoValue: load.cargoValue ?? null,
    subject: load.subject ?? null,
    fromAddress: load.fromAddress ?? null,
    receivedAt: load.receivedAt,
    threadUrl: load.threadUrl ?? null,
  });
  logActivity({ actor, action: 'created', loadId: load.id, bookingRef: load.bookingRef });
  return selectLoadById(load.id);
}

const selectLoadStmt = db.prepare(`SELECT * FROM loads WHERE id = ?`);
function selectLoadById(id) {
  const row = selectLoadStmt.get(id);
  return row ? rowToLoad(row) : null;
}

const insertNote = db.prepare(`
  INSERT INTO notes (load_id, author, text, timestamp) VALUES (?, ?, ?, ?)
`);

function addNote(loadId, actor, text) {
  const now = new Date().toISOString();
  insertNote.run(loadId, actor, text, now);
  logActivity({
    actor, action: 'noted', loadId, bookingRef: bookingRefFor(loadId),
    detail: text.length > 80 ? text.slice(0, 79) + '…' : text,
  });
  return selectLoadById(loadId);
}

// Touch last_action_at without changing workflow state. Used when ops replies
// from the email view (future hook); not wired by any frontend action yet.
const setTouch = db.prepare(`UPDATE loads SET last_action_at = ?, last_action_by = ? WHERE id = ?`);
function touchLoad(loadId, actor) {
  const now = new Date().toISOString();
  setTouch.run(now, actor, loadId);
  logActivity({ actor, action: 'touched', loadId, bookingRef: bookingRefFor(loadId) });
  return selectLoadById(loadId);
}

const insertActivity = db.prepare(`
  INSERT INTO activity (timestamp, actor, action, load_id, booking_ref, detail)
  VALUES (?, ?, ?, ?, ?, ?)
`);
function logActivity({ actor, action, loadId, bookingRef, detail }) {
  insertActivity.run(new Date().toISOString(), actor ?? null, action,
                    loadId ?? null, bookingRef ?? null, detail ?? null);
}

const refLookup = db.prepare(`SELECT booking_ref FROM loads WHERE id = ?`);
function bookingRefFor(id) {
  const row = refLookup.get(id);
  return row ? row.booking_ref : null;
}

module.exports = {
  listLoads,
  selectLoadById,
  createLoad,
  addNote,
  touchLoad,
  listActivityToday,
};
