import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {fileExists} from './fs'
import {getMapDir} from './paths'

export interface StatusSummary {
  initialized: boolean
  repoCount: number
  runCount: number
  maps: Array<{
    mapId: string
    hasScope: boolean
    hasServiceMap: boolean
    hasFlowGraph: boolean
    hasFlowValidation: boolean
    updatedAt?: string
  }>
}

export function getStatusSummary(db: Database.Database, cwd = process.cwd()): StatusSummary {
  const repoCount = (db.prepare('SELECT COUNT(*) AS count FROM repo_registry').get() as {count: number}).count
  const runCount = (db.prepare('SELECT COUNT(*) AS count FROM run_log').get() as {count: number}).count

  const mapRows = db
    .prepare("SELECT DISTINCT map_id FROM run_log WHERE map_id IS NOT NULL AND map_id != '' ORDER BY map_id")
    .all() as Array<{map_id: string}>

  const maps = mapRows.map(({map_id}) => {
    const mapDir = getMapDir(map_id, cwd)
    const scopePath = path.join(mapDir, 'scope.json')
    const updatedAt = fileExists(scopePath) ? fs.statSync(scopePath).mtime.toISOString() : undefined
    return {
      mapId: map_id,
      hasScope: fileExists(scopePath),
      hasServiceMap: fileExists(path.join(mapDir, 'service-map.json')),
      hasFlowGraph: fileExists(path.join(mapDir, 'flow', 'graph.json')),
      hasFlowValidation: fileExists(path.join(mapDir, 'flow', 'validation.json')),
      updatedAt,
    }
  })

  return {
    initialized: true,
    repoCount,
    runCount,
    maps,
  }
}
