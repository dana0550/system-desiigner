import path from 'node:path'
import {APP_DIR, CONFIG_FILE, DB_FILE} from './constants'

export function getProjectRoot(cwd = process.cwd()): string {
  return cwd
}

export function getAppDir(cwd = process.cwd()): string {
  return path.join(getProjectRoot(cwd), APP_DIR)
}

export function getConfigPath(cwd = process.cwd()): string {
  return path.join(getAppDir(cwd), CONFIG_FILE)
}

export function getDbPath(cwd = process.cwd()): string {
  return path.join(getAppDir(cwd), DB_FILE)
}

export function getMapDir(mapId: string, cwd = process.cwd()): string {
  return path.join(getProjectRoot(cwd), 'maps', mapId)
}

export function getCatalogDir(cwd = process.cwd()): string {
  return path.join(getProjectRoot(cwd), 'catalog')
}

export function getDocsDir(cwd = process.cwd()): string {
  return path.join(getProjectRoot(cwd), 'docs')
}

export function getCodexDir(cwd = process.cwd()): string {
  return path.join(getProjectRoot(cwd), 'codex')
}
