import Database from 'better-sqlite3'
import {ensureDir} from './fs'
import {getAppDir, getDbPath} from './paths'

export function openDb(cwd = process.cwd()): Database.Database {
  ensureDir(getAppDir(cwd))
  const db = new Database(getDbPath(cwd))
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repo_registry (
      name TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      org TEXT NOT NULL,
      default_branch TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      fork INTEGER NOT NULL DEFAULT 0,
      html_url TEXT,
      local_path TEXT,
      source TEXT NOT NULL,
      last_synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      map_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT
    );
  `)
}
