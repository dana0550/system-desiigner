import path from 'node:path'
import {SCHEMA_VERSION} from './constants'
import {fileExists, readJsonFile, writeJsonFile, writeTextFile} from './fs'
import {getMapDir} from './paths'
import {ScopeManifest} from './types'

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

export function computeEffectiveScope(
  discovered: string[],
  explicitInclude: string[],
  explicitExclude: string[],
): string[] {
  const overlap = explicitInclude.filter((repo) => explicitExclude.includes(repo))
  if (overlap.length > 0) {
    throw new Error(`Invalid scope overrides. Same repo appears in include and exclude: ${overlap.join(', ')}`)
  }

  const combined = new Set<string>(discovered)
  for (const repo of explicitInclude) {
    combined.add(repo)
  }

  for (const repo of explicitExclude) {
    combined.delete(repo)
  }

  return uniqueSorted(Array.from(combined))
}

export function loadScopeManifest(mapId: string, cwd = process.cwd()): ScopeManifest {
  const scopePath = path.join(getMapDir(mapId, cwd), 'scope.json')
  if (!fileExists(scopePath)) {
    throw new Error(`Scope manifest not found for map '${mapId}'. Run 'sdx map create ${mapId} --org <org>' first.`)
  }

  return readJsonFile<ScopeManifest>(scopePath)
}

export function saveScopeManifest(manifest: ScopeManifest, cwd = process.cwd()): string {
  const mapDir = getMapDir(manifest.mapId, cwd)
  const scopePath = path.join(mapDir, 'scope.json')
  manifest.generatedAt = new Date().toISOString()
  manifest.discovered = uniqueSorted(manifest.discovered)
  manifest.explicitInclude = uniqueSorted(manifest.explicitInclude)
  manifest.explicitExclude = uniqueSorted(manifest.explicitExclude)
  manifest.effective = computeEffectiveScope(manifest.discovered, manifest.explicitInclude, manifest.explicitExclude)
  writeJsonFile(scopePath, manifest)

  const logPath = path.join(mapDir, 'scope-change-log.md')
  const rows = [
    '# Scope Change Log',
    '',
    '| Time | Action | Repositories | Note |',
    '|---|---|---|---|',
    ...manifest.history.map((entry) => {
      const repos = entry.repos.length > 0 ? entry.repos.join(', ') : '-'
      const note = entry.note ?? '-'
      return `| ${entry.at} | ${entry.action} | ${repos} | ${note} |`
    }),
    '',
  ]
  writeTextFile(logPath, rows.join('\n'))

  return scopePath
}

export function createScopeManifest(mapId: string, org: string, discovered: string[], cwd = process.cwd()): ScopeManifest {
  const defaultExclude = discovered.filter((repo) => repo.endsWith('-fork') || repo.endsWith('-archive'))
  const manifest: ScopeManifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    org,
    discovered: uniqueSorted(discovered),
    explicitInclude: [],
    explicitExclude: uniqueSorted(defaultExclude),
    effective: [],
    history: [
      {
        at: new Date().toISOString(),
        action: 'create',
        repos: uniqueSorted(discovered),
        note: 'Map created from discovered repositories',
      },
    ],
  }

  manifest.effective = computeEffectiveScope(manifest.discovered, manifest.explicitInclude, manifest.explicitExclude)
  return manifest
}

export function applyScopeChange(
  mapId: string,
  action: 'include' | 'exclude' | 'remove_override' | 'sync' | 'prompt_apply',
  repos: string[],
  note?: string,
  cwd = process.cwd(),
): ScopeManifest {
  const manifest = loadScopeManifest(mapId, cwd)
  const cleanRepos = uniqueSorted(repos)

  if (action === 'include') {
    manifest.explicitInclude = uniqueSorted([...manifest.explicitInclude, ...cleanRepos])
    manifest.explicitExclude = manifest.explicitExclude.filter((repo) => !cleanRepos.includes(repo))
  }

  if (action === 'exclude') {
    manifest.explicitExclude = uniqueSorted([...manifest.explicitExclude, ...cleanRepos])
    manifest.explicitInclude = manifest.explicitInclude.filter((repo) => !cleanRepos.includes(repo))
  }

  if (action === 'remove_override') {
    manifest.explicitInclude = manifest.explicitInclude.filter((repo) => !cleanRepos.includes(repo))
    manifest.explicitExclude = manifest.explicitExclude.filter((repo) => !cleanRepos.includes(repo))
  }

  manifest.history.push({
    at: new Date().toISOString(),
    action,
    repos: cleanRepos,
    note,
  })

  saveScopeManifest(manifest, cwd)
  return manifest
}
