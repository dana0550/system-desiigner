import path from 'node:path'
import Database from 'better-sqlite3'
import {extractContracts, renderContractsMarkdown} from './contracts'
import {renderArchitectureDoc} from './docs'
import {writeJsonFile, writeTextFile} from './fs'
import {buildServiceMapArtifact, renderServiceMapMarkdown, renderServiceMapMermaid} from './mapBuilder'
import {listAllRepos} from './repoRegistry'
import {loadScopeManifest, saveScopeManifest} from './scope'

export interface MapBuildResult {
  jsonPath: string
  markdownPath: string
  mermaidPath: string
  mapDir: string
}

export function buildMapArtifacts(mapId: string, db: Database.Database, cwd = process.cwd()): MapBuildResult {
  const scope = loadScopeManifest(mapId, cwd)
  saveScopeManifest(scope, cwd)

  const repoMap = new Map(listAllRepos(db).map((repo) => [repo.name, repo]))
  const artifact = buildServiceMapArtifact(mapId, scope, repoMap)

  const mapDir = path.join(cwd, 'maps', mapId)
  const jsonPath = path.join(mapDir, 'service-map.json')
  const markdownPath = path.join(mapDir, 'service-map.md')
  const mermaidPath = path.join(mapDir, 'service-map.mmd')

  writeJsonFile(jsonPath, artifact)
  writeTextFile(markdownPath, renderServiceMapMarkdown(artifact))
  writeTextFile(mermaidPath, renderServiceMapMermaid(artifact))

  return {
    jsonPath,
    markdownPath,
    mermaidPath,
    mapDir,
  }
}

export interface ContractExtractionResult {
  jsonPath: string
  markdownPath: string
  count: number
}

export function extractContractArtifacts(mapId: string, db: Database.Database, cwd = process.cwd()): ContractExtractionResult {
  const scope = loadScopeManifest(mapId, cwd)
  const repoMap = new Map(listAllRepos(db).map((repo) => [repo.name, repo]))
  const contracts = extractContracts(mapId, scope, repoMap)

  const mapDir = path.join(cwd, 'maps', mapId)
  const jsonPath = path.join(mapDir, 'contracts.json')
  const markdownPath = path.join(mapDir, 'contracts.md')

  writeJsonFile(jsonPath, contracts)
  writeTextFile(markdownPath, renderContractsMarkdown(contracts, mapId))

  return {
    jsonPath,
    markdownPath,
    count: contracts.length,
  }
}

export interface DocsGenerationResult {
  architecturePath: string
  dependencyPath: string
}

export function generateDocsArtifacts(mapId: string, db: Database.Database, cwd = process.cwd()): DocsGenerationResult {
  const scope = loadScopeManifest(mapId, cwd)
  const repoMap = new Map(listAllRepos(db).map((repo) => [repo.name, repo]))
  const serviceMap = buildServiceMapArtifact(mapId, scope, repoMap)
  const contracts = extractContracts(mapId, scope, repoMap)

  const architectureContent = renderArchitectureDoc(mapId, scope, serviceMap, contracts)
  const architecturePath = path.join(cwd, 'docs', 'architecture', `${mapId}.md`)
  writeTextFile(architecturePath, architectureContent)

  const dependencyPath = path.join(cwd, 'catalog', 'dependencies', `${mapId}.md`)
  const relationLines = [
    `# Dependency Summary: ${mapId}`,
    '',
    ...serviceMap.edges.map((edge) => `- ${edge.from} ${edge.relation} ${edge.to}`),
    '',
  ]
  writeTextFile(dependencyPath, relationLines.join('\n'))

  return {
    architecturePath,
    dependencyPath,
  }
}
