'use strict';

/**
 * Canned-responses store (DB-backed).
 *
 * Canned responses are user-editable, so they live in the encrypted hypercare.db
 * (on the persistent disk) rather than a config file — otherwise every redeploy
 * would wipe edits back to the committed JSON. On first run the table is seeded
 * from config/reply-templates.json so the dashboard ships with sensible defaults.
 *
 * Shape returned by getConfig() is unchanged from the old file loader
 * ({ templates: { name: body } }) so the reply dropdown and /api/reply-templates
 * keep working without changes.
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

db.exec(`
  CREATE TABLE IF NOT EXISTS canned_responses (
    name       TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// One-time seed from the bundled defaults if the table is empty.
(function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM canned_responses').get();
  if (count > 0) return;
  let defaults = {};
  try {
    defaults = require('./reply-templates-config').getConfig().templates || {};
  } catch (e) {
    console.warn('[canned-responses] no seed defaults available:', e.message);
  }
  const now = new Date().toISOString();
  const stmt = db.prepare('INSERT OR IGNORE INTO canned_responses (name, body, updated_at) VALUES (?, ?, ?)');
  const insertMany = db.transaction((entries) => {
    for (const [name, body] of entries) stmt.run(name, String(body), now);
  });
  insertMany(Object.entries(defaults));
  console.log(`[canned-responses] seeded ${Object.keys(defaults).length} default responses`);
})();

/** Build a 400 the errorHandler surfaces verbatim to the SPA. */
function badRequest(message, code) {
  const err = new Error(message);
  err.status = 400;
  err.code = code || 'canned.invalid';
  err.expose = true;
  return err;
}

/** Return { templates: { name: body } } in stable (insertion) order. */
function getConfig() {
  const rows = db.prepare('SELECT name, body FROM canned_responses ORDER BY rowid').all();
  const templates = {};
  for (const r of rows) templates[r.name] = r.body;
  return { templates };
}

/** Create or update a response. Returns the full config afterwards. */
function upsert(rawName, rawBody) {
  const name = String(rawName || '').trim();
  if (!name) throw badRequest('A name is required.', 'canned.invalid_name');
  if (name.length > 80) throw badRequest('Name is too long (max 80 characters).', 'canned.invalid_name');
  const body = String(rawBody == null ? '' : rawBody);
  if (!body.trim()) throw badRequest('The response body cannot be empty.', 'canned.invalid_body');
  if (body.length > 5000) throw badRequest('Response is too long (max 5000 characters).', 'canned.invalid_body');

  db.prepare(`
    INSERT INTO canned_responses (name, body, updated_at) VALUES (@name, @body, @ts)
    ON CONFLICT(name) DO UPDATE SET body = @body, updated_at = @ts
  `).run({ name, body, ts: new Date().toISOString() });
  return getConfig();
}

/** Delete a response by name. Returns the full config afterwards. */
function remove(rawName) {
  const name = String(rawName || '').trim();
  if (!name) throw badRequest('A name is required.', 'canned.invalid_name');
  db.prepare('DELETE FROM canned_responses WHERE name = ?').run(name);
  return getConfig();
}

module.exports = { getConfig, upsert, remove };
