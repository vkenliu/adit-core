/**
 * SQLite database connection and migration runner.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations.js";

/** Open (or create) the SQLite database and run pending migrations */
export function openDatabase(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");

  runMigrations(db);
  return db;
}

/** Run all pending migrations inside a transaction */
function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id   INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM _migrations")
      .all()
      .map((row) => (row as { id: number }).id),
  );

  const pending = migrations.filter((m) => !applied.has(m.id));
  if (pending.length === 0) return;

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
        migration.id,
        migration.name,
      );
    }
  });

  applyAll();
}

/** Close the database connection gracefully */
export function closeDatabase(db: Database.Database): void {
  db.close();
}
