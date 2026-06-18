/**
 * One-shot migration: plaintext hypercare.db -> SQLCipher-encrypted copy.
 *
 * Run once at the cutover. Stop the app, run this, then move
 * hypercare.encrypted.db over the plaintext one. Kept in tree so the
 * cutover is reproducible (e.g. in another environment).
 *
 * Usage: cd backend && node --env-file=.env scripts/migrate-to-sqlcipher.js
 */

const path = require('path');
const fs = require('fs');
const { copyDb } = require('./lib/copy-db');

const key = process.env.DB_ENCRYPTION_KEY;
if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error('DB_ENCRYPTION_KEY missing or not 64 hex chars');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const PLAIN = path.join(DATA_DIR, 'hypercare.db');
const ENC = path.join(DATA_DIR, 'hypercare.encrypted.db');

if (!fs.existsSync(PLAIN)) {
  console.error('No plaintext DB found at', PLAIN);
  process.exit(1);
}
if (fs.existsSync(ENC)) fs.unlinkSync(ENC);

const r = copyDb({ path: PLAIN, key: null }, { path: ENC, key });
console.log(`encrypted DB written: ${ENC} — ${r.tables} tables, ${r.rows} rows`);
