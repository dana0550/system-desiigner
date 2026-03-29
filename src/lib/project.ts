import path from 'node:path'
import Database from 'better-sqlite3'
import {createDefaultConfig, hasConfig, loadConfig, saveConfig} from './config'
import {openDb} from './db'
import {ensureDir} from './fs'
import {getCatalogDir, getCodexDir, getDocsDir, getMapDir, getProjectRoot} from './paths'
import {SdxConfig} from './types'

export interface ProjectContext {
  cwd: string
  rootDir: string
  db: Database.Database
  config: SdxConfig
}

export function ensureStandardDirs(cwd = process.cwd()): void {
  ensureDir(getCatalogDir(cwd))
  ensureDir(path.join(getCatalogDir(cwd), 'services'))
  ensureDir(path.join(getCatalogDir(cwd), 'contracts'))
  ensureDir(path.join(getCatalogDir(cwd), 'dependencies'))
  ensureDir(getDocsDir(cwd))
  ensureDir(path.join(getDocsDir(cwd), 'architecture'))
  ensureDir(path.join(getDocsDir(cwd), 'adr'))
  ensureDir(path.join(cwd, 'plans', 'reviews'))
  ensureDir(path.join(cwd, 'handoffs'))
  ensureDir(path.join(cwd, 'publish', 'notices'))
  ensureDir(path.join(cwd, 'publish', 'sync'))
  ensureDir(path.join(getCodexDir(cwd), 'context-packs'))
  ensureDir(path.join(getCodexDir(cwd), 'runs'))
  ensureDir(path.join(cwd, 'diagrams'))
  ensureDir(path.join(cwd, 'snapshots'))
}

export function initProject(cwd = process.cwd()): ProjectContext {
  if (!hasConfig(cwd)) {
    const config = createDefaultConfig(cwd)
    saveConfig(config, cwd)
  }

  ensureStandardDirs(cwd)

  return {
    cwd,
    rootDir: getProjectRoot(cwd),
    db: openDb(cwd),
    config: loadConfig(cwd),
  }
}

export function loadProject(cwd = process.cwd()): ProjectContext {
  if (!hasConfig(cwd)) {
    throw new Error('sdx is not initialized. Run `sdx init` first.')
  }

  ensureStandardDirs(cwd)

  return {
    cwd,
    rootDir: getProjectRoot(cwd),
    db: openDb(cwd),
    config: loadConfig(cwd),
  }
}

export function recordRun(
  db: Database.Database,
  runType: string,
  status: 'ok' | 'error',
  mapId?: string,
  metadata?: unknown,
): void {
  db.prepare(
    'INSERT INTO run_log (run_type, map_id, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)',
  ).run(runType, mapId ?? null, status, new Date().toISOString(), metadata ? JSON.stringify(metadata) : null)
}

export function ensureMapDir(mapId: string, cwd = process.cwd()): string {
  const mapDir = getMapDir(mapId, cwd)
  ensureDir(mapDir)
  return mapDir
}
