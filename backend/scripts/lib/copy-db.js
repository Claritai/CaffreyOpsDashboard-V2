/**
 * Copy a SQLCipher-encrypted SQLite database to a new file by replaying
 * schema + indexes + rows. Used by both the original plaintext->encrypted
 * migration and the nightly backup (encrypted->encrypted).
 *
 * Why not Database.backup()? In better-sqlite3-multiple-ciphers, .backup()
 * doesn't propagate the cipher to the destination — the copy comes out
 * "incompatible" with the encrypted source. Why not VACUUM INTO? Same
 * issue. Replay is the path that's known to work for our build.
 *
 * srcOpts / dstOpts: { path, key }
 *   - key === null => open plaintext (used once, by the initial migration)
 *   - key === '<64 hex>' => SQLCipher with that key
 */

const Database = require('better-sqlite3-multiple-ciphers');

function openDb({ path, key }) {
  const db = new Database(path);
  if (key) {
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`key="x'${key}'"`);
  }
  db.pragma('journal_mode = WAL');
  return db;
}

function copyDb(srcOpts, dstOpts) {
  const src = openDb({ ...srcOpts, path: srcOpts.path });
  // open the dst read-write; we'll write into it
  const dst = openDb(dstOpts);
  src.pragma('wal_checkpoint(TRUNCATE)');

  dst.pragma('foreign_keys = OFF');
  const objects = src.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END
  `).all();

  const tables = [];
  dst.exec('BEGIN');
  for (const obj of objects) {
    dst.exec(obj.sql);
    if (obj.type === 'table') tables.push(obj.name);
  }
  let totalRows = 0;
  for (const table of tables) {
    const rows = src.prepare(`SELECT * FROM "${table}"`).all();
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(',');
    const colList = cols.map(c => `"${c}"`).join(',');
    const ins = dst.prepare(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`);
    for (const row of rows) ins.run(cols.map(c => row[c]));
    totalRows += rows.length;
  }
  dst.exec('COMMIT');
  dst.pragma('foreign_keys = ON');

  src.close();
  dst.close();
  return { tables: tables.length, rows: totalRows };
}

module.exports = { copyDb };
