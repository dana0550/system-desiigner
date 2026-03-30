import path from 'node:path'
import Database from 'better-sqlite3'
import {RepoRecord} from './types'

interface RepoRow {
  name: string
  full_name: string
  org: string
  default_branch: string | null
  archived: number
  fork: number
  html_url: string | null
  local_path: string | null
  source: 'github' | 'local' | 'hybrid'
  last_synced_at: string | null
}

function toRecord(row: RepoRow): RepoRecord {
  return {
    name: row.name,
    fullName: row.full_name,
    org: row.org,
    defaultBranch: row.default_branch ?? undefined,
    archived: Boolean(row.archived),
    fork: Boolean(row.fork),
    htmlUrl: row.html_url ?? undefined,
    localPath: row.local_path ?? undefined,
    source: row.source,
    lastSyncedAt: row.last_synced_at ?? undefined,
  }
}

export function upsertRepos(db: Database.Database, repos: RepoRecord[]): void {
  const stmt = db.prepare(`
    INSERT INTO repo_registry (name, full_name, org, default_branch, archived, fork, html_url, local_path, source, last_synced_at)
    VALUES (@name, @full_name, @org, @default_branch, @archived, @fork, @html_url, @local_path, @source, @last_synced_at)
    ON CONFLICT(name) DO UPDATE SET
      full_name=excluded.full_name,
      org=excluded.org,
      default_branch=excluded.default_branch,
      archived=excluded.archived,
      fork=excluded.fork,
      html_url=excluded.html_url,
      local_path=COALESCE(repo_registry.local_path, excluded.local_path),
      source=CASE
        WHEN repo_registry.local_path IS NOT NULL AND excluded.source='github' THEN 'hybrid'
        ELSE excluded.source
      END,
      last_synced_at=excluded.last_synced_at
  `)

  const insertMany = db.transaction((rows: RepoRecord[]) => {
    for (const repo of rows) {
      stmt.run({
        name: repo.name,
        full_name: repo.fullName,
        org: repo.org,
        default_branch: repo.defaultBranch ?? null,
        archived: repo.archived ? 1 : 0,
        fork: repo.fork ? 1 : 0,
        html_url: repo.htmlUrl ?? null,
        local_path: repo.localPath ?? null,
        source: repo.source,
        last_synced_at: repo.lastSyncedAt ?? null,
      })
    }
  })

  insertMany(repos)
}

export function setLocalRepoPath(db: Database.Database, name: string, localPath: string, org?: string): RepoRecord {
  const normalized = path.resolve(localPath)
  const now = new Date().toISOString()

  const existing = db
    .prepare('SELECT * FROM repo_registry WHERE name = ?')
    .get(name) as RepoRow | undefined

  if (existing) {
    db.prepare(
      `UPDATE repo_registry
       SET local_path = ?,
           source = CASE WHEN source='github' THEN 'hybrid' ELSE 'local' END,
           last_synced_at = ?
       WHERE name = ?`,
    ).run(normalized, now, name)
  } else {
    db.prepare(
      `INSERT INTO repo_registry (name, full_name, org, archived, fork, local_path, source, last_synced_at)
       VALUES (?, ?, ?, 0, 0, ?, 'local', ?)`,
    ).run(name, org ? `${org}/${name}` : name, org ?? 'local', normalized, now)
  }

  return getRepoByName(db, name)
}

export function getRepoByName(db: Database.Database, name: string): RepoRecord {
  const row = db.prepare('SELECT * FROM repo_registry WHERE name = ?').get(name) as RepoRow | undefined
  if (!row) {
    throw new Error(`Repository not found: ${name}`)
  }

  return toRecord(row)
}

export function listReposByOrg(db: Database.Database, org: string): RepoRecord[] {
  const rows = db
    .prepare('SELECT * FROM repo_registry WHERE org = ? ORDER BY name')
    .all(org) as RepoRow[]

  return rows.map(toRecord)
}

export function listAllRepos(db: Database.Database): RepoRecord[] {
  const rows = db.prepare('SELECT * FROM repo_registry ORDER BY org, name').all() as RepoRow[]
  return rows.map(toRecord)
}
