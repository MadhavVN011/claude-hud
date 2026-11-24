import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function database(file: string, migrations: readonly string[]): DatabaseSync {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'a', 0o600); fs.closeSync(fd);
    fs.chmodSync(file, 0o600);
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > migrations.length) { db.close(); throw new Error('Database schema is newer than this collector/server'); }
  for (let i = version; i < migrations.length; i++) {
    transaction(db, () => { db.exec(migrations[i]); db.exec(`PRAGMA user_version=${i + 1}`); });
  }
  return db;
}
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = run(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
