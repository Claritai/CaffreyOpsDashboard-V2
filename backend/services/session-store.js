/**
 * Persistent, SQLCipher-encrypted session store for express-session.
 *
 * Sessions outlive backend restarts (the in-memory MemoryStore wiped them).
 * The store is a separate SQLite file from hypercare.db but uses the same
 * DB_ENCRYPTION_KEY, so the msalAccount identifier living in each session
 * row isn't written to disk in plaintext.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3-multiple-ciphers');
const SqliteStore = require('better-sqlite3-session-store');

const SESSIONS_PATH = path.join(__dirname, '..', 'data', 'sessions.db');
fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true });

function buildSessionStore(session) {
  const key = process.env.DB_ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('DB_ENCRYPTION_KEY missing or not 64 hex chars — refusing to open sessions.db');
  }

  const db = new Database(SESSIONS_PATH);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma(`key="x'${key}'"`);
  db.pragma('journal_mode = WAL');

  const Store = SqliteStore(session);
  return new Store({
    client: db,
    expired: {
      clear: true,
      intervalMs: 15 * 60 * 1000, // sweep every 15 min
    },
  });
}

module.exports = { buildSessionStore };
