import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {z} from 'zod'
import {generateArchitecturePack, buildArchitectureModel} from './architecture'
import {SCHEMA_VERSION} from './constants'
import {extractContracts} from './contracts'
import {fileExists, readJsonFile, safeReadText, writeTextFile} from './fs'
import {buildServiceMapArtifact} from './mapBuilder'
import {listAllRepos} from './repoRegistry'
import {loadScopeManifest} from './scope'
import {
  ArchitectureEdge,
  ArchitectureModelArtifact,
  ContractRecord,
  RepoRecord,
  ScopeManifest,
  ServiceMapArtifact,
} from './types'
import {getCliPackageVersion} from './version'

export const README_SECTION_ORDER = [
  'what_is_this_system',
  'architecture_glance',
  'service_catalog',
  'critical_flows',
  'event_async_topology',
  'contracts_index',
  'repository_index',
  'environments_deployment',
  'data_stores_boundaries',
  'security_compliance',
  'local_dev_contribution',
  'runbooks_escalation',
  'adr_index',
  'glossary',
  'changelog_metadata',
] as const

export type ReadmeSectionId = (typeof README_SECTION_ORDER)[number]

const SECTION_SET = new Set<ReadmeSectionId>(README_SECTION_ORDER)

const SECTION_TITLES: Record<ReadmeSectionId, string> = {
  what_is_this_system: 'What this org/system is',
  architecture_glance: 'Architecture at a glance',
  service_catalog: 'Service catalog table',
  critical_flows: 'Critical request/data flows',
  event_async_topology: 'Event and async topology',
  contracts_index: 'Contracts and interface index',
  repository_index: 'Repository index with ownership',
  environments_deployment: 'Environments and deployment topology',
  data_stores_boundaries: 'Data stores and boundaries',
  security_compliance: 'Security/compliance considerations',
  local_dev_contribution: 'Local development and contribution workflow',
  runbooks_escalation: 'Operational runbooks and escalation paths',
  adr_index: 'ADR and design decision index',
  glossary: 'Glossary',
  changelog_metadata: 'Change log / last generated metadata',
}

const REQUIRED_DIAGRAM_NAMES = ['system-context.mmd', 'service-dependency.mmd', 'core-request-flow.mmd'] as const

const README_CONFIG_SCHEMA = z.object({
  sections: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
      enabled: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
  repos: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  domainGroups: z
    .array(
      z.object({
        name: z.string(),
        match: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  ownerTeamOverrides: z.record(z.string(), z.string()).optional(),
  diagram: z
    .object({
      autoGenerateMissing: z.boolean().optional(),
      includeC4Links: z.boolean().optional(),
    })
    .optional(),
  customIntro: z.string().optional(),
  staleThresholdHours: z.number().positive().optional(),
})

export interface ReadmeConfig {
  sections?: {
    include?: string[]
    exclude?: string[]
    enabled?: Record<string, boolean>
  }
  repos?: {
    include?: string[]
    exclude?: string[]
  }
  domainGroups?: Array<{
    name: string
    match: string[]
  }>
  ownerTeamOverrides?: Record<string, string>
  diagram?: {
    autoGenerateMissing?: boolean
    includeC4Links?: boolean
  }
  customIntro?: string
  staleThresholdHours?: number
}

interface SourceRef {
  id: string
  label: string
  path: string
  exists: boolean
  generatedAt?: string
  stale: boolean
  required: boolean
  note?: string
}

interface DiagramPaths {
  baseDir: string
  systemContext: string
  serviceDependency: string
  sequence: string
  optionalSystemLandscape: string
  optionalContainer: string
  optionalArchitectureIndex: string
}

interface ServiceCatalogRow {
  serviceName: string
  repository: string
  ownerTeam: string
  runtime: string
  apiEventSurface: string
  dependencies: string
  dataStores: string
  deployTarget: string
  tier: string
  status: string
}

interface ReadmeContext {
  cwd: string
  mapId: string
  scope: ScopeManifest
  selectedRepos: string[]
  repoMap: Map<string, RepoRecord>
  serviceMap: ServiceMapArtifact
  contracts: ContractRecord[]
  architectureModel: ArchitectureModelArtifact
  diagrams: DiagramPaths
  sources: SourceRef[]
  staleThresholdHours: number
  now: Date
  outputPath: string
  config: ReadmeConfig
  sourceSnapshotAt: string
  coreRequestPath: ArchitectureEdge[]
  sourceRepoSyncAt?: string
}

interface SectionPayload {
  id: ReadmeSectionId
  title: string
  body: string[]
  sourceIds: string[]
}

export interface GenerateReadmeOptions {
  mapId: string
  db: Database.Database
  cwd?: string
  output?: string
  includeSections?: ReadmeSectionId[]
  excludeSections?: ReadmeSectionId[]
  check?: boolean
  dryRun?: boolean
}

export interface GenerateReadmeResult {
  outputPath: string
  sections: ReadmeSectionId[]
  stale: boolean
  staleSources: SourceRef[]
  missingSources: SourceRef[]
  changed: boolean
  wroteFile: boolean
  checkPassed: boolean
  summary: string
  diff?: string
}

interface RenderOutput {
  content: string
  sourceRefs: SourceRef[]
}

interface CorePathStep {
  from: string
  to: string
  confidence: number
}

function normalizeRepoName(value: string): string {
  return value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').split('/').pop() ?? value.trim()
}

function asRelative(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath)
  return relative.length === 0 ? '.' : relative.split(path.sep).join('/')
}

function toLinkPath(targetPath: string, outputPath: string): string {
  const relative = path.relative(path.dirname(outputPath), targetPath).split(path.sep).join('/')
  if (relative.startsWith('.')) {
    return relative
  }

  return `./${relative}`
}

function safeTimestamp(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return undefined
  }

  return parsed
}

function isOlderThan(value: Date | undefined, thresholdHours: number, now: Date): boolean {
  if (!value) {
    return true
  }

  const elapsedMs = now.getTime() - value.getTime()
  return elapsedMs > thresholdHours * 60 * 60 * 1000
}

function loadReadmeConfig(cwd: string): {config: ReadmeConfig; sourcePath?: string} {
  const candidates = [
    path.join(cwd, '.sdx', 'readme.config.json'),
    path.join(cwd, '.sdx', 'readme.config.yaml'),
    path.join(cwd, '.sdx', 'readme.config.yml'),
  ]

  for (const filePath of candidates) {
    if (!fileExists(filePath)) {
      continue
    }

    const text = safeReadText(filePath)
    const parsed = filePath.endsWith('.json') ? JSON.parse(text) : YAML.parse(text)
    const config = README_CONFIG_SCHEMA.parse(parsed)
    return {
      config,
      sourcePath: filePath,
    }
  }

  return {config: {}}
}

export function parseReadmeSectionList(input: string | undefined): ReadmeSectionId[] {
  if (!input) {
    return []
  }

  const tokens = input
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const invalid = tokens.filter((token) => !SECTION_SET.has(token as ReadmeSectionId))
  if (invalid.length > 0) {
    throw new Error(`Unknown section id(s): ${invalid.join(', ')}. Valid ids: ${README_SECTION_ORDER.join(', ')}`)
  }

  return [...new Set(tokens as ReadmeSectionId[])]
}

function selectSections(
  config: ReadmeConfig,
  includeSections: ReadmeSectionId[],
  excludeSections: ReadmeSectionId[],
): ReadmeSectionId[] {
  let ordered = [...README_SECTION_ORDER]

  const configEnabled = config.sections?.enabled ?? {}
  ordered = ordered.filter((section) => configEnabled[section] !== false)

  const configInclude = (config.sections?.include ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
  if (configInclude.length > 0) {
    ordered = ordered.filter((section) => configInclude.includes(section))
  }

  const configExclude = (config.sections?.exclude ?? [])
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
  if (configExclude.length > 0) {
    ordered = ordered.filter((section) => !configExclude.includes(section))
  }

  if (includeSections.length > 0) {
    ordered = ordered.filter((section) => includeSections.includes(section))
  }

  if (excludeSections.length > 0) {
    ordered = ordered.filter((section) => !excludeSections.includes(section))
  }

  if (ordered.length === 0) {
    throw new Error('No README sections selected after include/exclude filtering.')
  }

  return ordered
}

function readGeneratedAtFromJson(filePath: string): string | undefined {
  if (!fileExists(filePath)) {
    return undefined
  }

  try {
    const payload = readJsonFile<Record<string, unknown>>(filePath)
    const value = payload['generatedAt']
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function sourceFromFile(
  id: string,
  label: string,
  filePath: string,
  cwd: string,
  thresholdHours: number,
  now: Date,
  required: boolean,
): SourceRef {
  const exists = fileExists(filePath)
  const generatedAt = exists
    ? readGeneratedAtFromJson(filePath) ?? fs.statSync(filePath).mtime.toISOString()
    : undefined

  const stale = exists ? isOlderThan(safeTimestamp(generatedAt), thresholdHours, now) : true

  return {
    id,
    label,
    path: asRelative(filePath, cwd),
    exists,
    generatedAt,
    stale,
    required,
    note: exists ? undefined : 'Missing source artifact',
  }
}

function detectRepoSyncTimestamp(repos: RepoRecord[], scopedRepos: string[]): string | undefined {
  const timestamps: Date[] = []
  for (const repoName of scopedRepos) {
    const repo = repos.find((entry) => entry.name === repoName)
    if (!repo?.lastSyncedAt) {
      return undefined
    }

    const parsed = safeTimestamp(repo.lastSyncedAt)
    if (!parsed) {
      return undefined
    }

    timestamps.push(parsed)
  }

  if (timestamps.length === 0) {
    return undefined
  }

  const oldest = timestamps.reduce((min, candidate) => (candidate.getTime() < min.getTime() ? candidate : min), timestamps[0])
  return oldest.toISOString()
}

function sourceFromRepoSync(
  repos: RepoRecord[],
  scopedRepos: string[],
  thresholdHours: number,
  now: Date,
): SourceRef {
  const generatedAt = detectRepoSyncTimestamp(repos, scopedRepos)
  const stale = isOlderThan(safeTimestamp(generatedAt), thresholdHours, now)
  return {
    id: 'repo-sync',
    label: 'Repository registry sync state',
    path: '.sdx/state.db#repo_registry',
    exists: generatedAt !== undefined,
    generatedAt,
    stale,
    required: true,
    note: generatedAt ? undefined : 'At least one scoped repo has no lastSyncedAt timestamp',
  }
}

function upsertSourceRef(sources: SourceRef[], source: SourceRef): void {
  const index = sources.findIndex((entry) => entry.id === source.id)
  if (index >= 0) {
    sources[index] = source
    return
  }

  sources.push(source)
}

function computeSnapshotTimestamp(sources: SourceRef[], fallback: Date): string {
  const sourceCandidates = sources
    .map((source) => safeTimestamp(source.generatedAt))
    .filter((entry): entry is Date => Boolean(entry))

  if (sourceCandidates.length === 0) {
    return fallback.toISOString()
  }

  return sourceCandidates.reduce((latest, candidate) => (candidate.getTime() > latest.getTime() ? candidate : latest), sourceCandidates[0]).toISOString()
}

function filterReposForReadme(scope: ScopeManifest, config: ReadmeConfig): string[] {
  const base = [...scope.effective]

  const include = new Set((config.repos?.include ?? []).map((value) => normalizeRepoName(value)))
  const exclude = new Set((config.repos?.exclude ?? []).map((value) => normalizeRepoName(value)))

  let selected = base
  if (include.size > 0) {
    selected = selected.filter((repo) => include.has(repo))
  }

  selected = selected.filter((repo) => !exclude.has(repo))
  selected.sort((a, b) => a.localeCompare(b))

  return selected
}

function loadServiceMap(
  mapId: string,
  scope: ScopeManifest,
  repoMap: Map<string, RepoRecord>,
  mapDir: string,
): ServiceMapArtifact {
  const filePath = path.join(mapDir, 'service-map.json')
  if (fileExists(filePath)) {
    return readJsonFile<ServiceMapArtifact>(filePath)
  }

  return buildServiceMapArtifact(mapId, scope, repoMap)
}

function loadContracts(
  mapId: string,
  scope: ScopeManifest,
  repoMap: Map<string, RepoRecord>,
  mapDir: string,
): ContractRecord[] {
  const filePath = path.join(mapDir, 'contracts.json')
  if (fileExists(filePath)) {
    return readJsonFile<ContractRecord[]>(filePath)
  }

  return extractContracts(mapId, scope, repoMap)
}

function loadArchitectureModel(mapId: string, db: Database.Database, cwd: string): ArchitectureModelArtifact {
  const filePath = path.join(cwd, 'maps', mapId, 'architecture', 'model.json')
  if (fileExists(filePath)) {
    return readJsonFile<ArchitectureModelArtifact>(filePath)
  }

  return buildArchitectureModel(mapId, db, cwd)
}

function diagramPaths(mapId: string, cwd: string): DiagramPaths {
  const baseDir = path.join(cwd, 'docs', 'architecture', mapId, 'diagrams')
  return {
    baseDir,
    systemContext: path.join(baseDir, 'system-context.mmd'),
    serviceDependency: path.join(baseDir, 'service-dependency.mmd'),
    sequence: path.join(baseDir, 'core-request-flow.mmd'),
    optionalSystemLandscape: path.join(baseDir, 'system-landscape.mmd'),
    optionalContainer: path.join(baseDir, 'container-communication.mmd'),
    optionalArchitectureIndex: path.join(cwd, 'docs', 'architecture', mapId, 'index.md'),
  }
}

function renderFlowchart(nodes: Array<{id: string; label: string}>, edges: Array<{from: string; to: string; relation: string}>): string {
  const lines = ['flowchart LR']

  for (const node of nodes.sort((a, b) => a.id.localeCompare(b.id))) {
    const nodeId = node.id.replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`  ${nodeId}["${node.label}"]`)
  }

  const sortedEdges = [...edges].sort((a, b) => {
    const left = `${a.from}|${a.to}|${a.relation}`
    const right = `${b.from}|${b.to}|${b.relation}`
    return left.localeCompare(right)
  })

  for (const edge of sortedEdges) {
    const fromId = edge.from.replace(/[^a-zA-Z0-9_]/g, '_')
    const toId = edge.to.replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`  ${fromId} -->|"${edge.relation}"| ${toId}`)
  }

  return `${lines.join('\n')}\n`
}

function renderSystemContextDiagram(model: ArchitectureModelArtifact): string {
  const allowed = new Set(['service', 'external', 'datastore', 'queue', 'team'])
  const nodes = model.nodes
    .filter((node) => allowed.has(node.type))
    .map((node) => ({id: node.id, label: node.label}))

  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = model.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({from: edge.from, to: edge.to, relation: edge.relation}))

  return renderFlowchart(nodes, edges)
}

function renderServiceDependencyDiagram(serviceMap: ServiceMapArtifact): string {
  const serviceNodes = serviceMap.nodes
    .filter((node) => node.type === 'service')
    .map((node) => ({id: node.id, label: node.label}))

  const serviceIds = new Set(serviceNodes.map((node) => node.id))
  const edges = serviceMap.edges
    .filter((edge) => serviceIds.has(edge.from) && serviceIds.has(edge.to))
    .map((edge) => ({from: edge.from, to: edge.to, relation: edge.relation}))

  return renderFlowchart(serviceNodes, edges)
}

function enumerateServiceCallEdges(model: ArchitectureModelArtifact): CorePathStep[] {
  const out: CorePathStep[] = []
  for (const edge of model.edges) {
    if (edge.relation !== 'calls') {
      continue
    }

    if (!edge.from.startsWith('service:') || !edge.to.startsWith('service:')) {
      continue
    }

    out.push({
      from: edge.from.replace('service:', ''),
      to: edge.to.replace('service:', ''),
      confidence: edge.provenance.confidence,
    })
  }

  return out.sort((a, b) => {
    const score = b.confidence - a.confidence
    if (score !== 0) {
      return score
    }

    const left = `${a.from}|${a.to}`
    const right = `${b.from}|${b.to}`
    return left.localeCompare(right)
  })
}

function enumerateDependencyEdges(serviceMap: ServiceMapArtifact): CorePathStep[] {
  const out: CorePathStep[] = []
  for (const edge of serviceMap.edges) {
    if (edge.relation !== 'depends_on') {
      continue
    }

    if (!edge.from.startsWith('service:') || !edge.to.startsWith('service:')) {
      continue
    }

    out.push({
      from: edge.from.replace('service:', ''),
      to: edge.to.replace('service:', ''),
      confidence: 0.45,
    })
  }

  return out.sort((a, b) => {
    const left = `${a.from}|${a.to}`
    const right = `${b.from}|${b.to}`
    return left.localeCompare(right)
  })
}

function bestPath(edges: CorePathStep[]): CorePathStep[] {
  if (edges.length === 0) {
    return []
  }

  const adjacency = new Map<string, CorePathStep[]>()
  for (const edge of edges) {
    const candidates = adjacency.get(edge.from) ?? []
    candidates.push(edge)
    adjacency.set(edge.from, candidates)
  }

  for (const candidateEdges of adjacency.values()) {
    candidateEdges.sort((a, b) => {
      const score = b.confidence - a.confidence
      if (score !== 0) {
        return score
      }

      return `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`)
    })
  }

  const starts = [...new Set(edges.map((edge) => edge.from))].sort((a, b) => a.localeCompare(b))

  let best: CorePathStep[] = []
  let bestScore = -1

  const maxDepth = 6

  function dfs(current: string, visited: Set<string>, pathEdges: CorePathStep[]): void {
    const outgoing = adjacency.get(current) ?? []
    if (pathEdges.length > 0) {
      const score = pathEdges.reduce((sum, step) => sum + step.confidence, 0) + pathEdges.length * 0.1
      const tieBreakerLeft = pathEdges.map((edge) => `${edge.from}->${edge.to}`).join('|')
      const tieBreakerRight = best.map((edge) => `${edge.from}->${edge.to}`).join('|')
      if (score > bestScore || (score === bestScore && tieBreakerLeft.localeCompare(tieBreakerRight) < 0)) {
        best = [...pathEdges]
        bestScore = score
      }
    }

    if (pathEdges.length >= maxDepth) {
      return
    }

    for (const edge of outgoing) {
      if (visited.has(edge.to)) {
        continue
      }

      visited.add(edge.to)
      pathEdges.push(edge)
      dfs(edge.to, visited, pathEdges)
      pathEdges.pop()
      visited.delete(edge.to)
    }
  }

  for (const start of starts) {
    const visited = new Set<string>([start])
    dfs(start, visited, [])
  }

  return best
}

function findCoreRequestPath(model: ArchitectureModelArtifact, serviceMap: ServiceMapArtifact): ArchitectureEdge[] {
  const callPath = bestPath(enumerateServiceCallEdges(model))
  const fallbackPath = callPath.length > 0 ? callPath : bestPath(enumerateDependencyEdges(serviceMap))

  if (fallbackPath.length === 0) {
    return []
  }

  return fallbackPath.map((step) => ({
    from: `service:${step.from}`,
    to: `service:${step.to}`,
    relation: 'calls',
    provenance: {
      source: callPath.length > 0 ? 'inferred' : 'declared',
      confidence: step.confidence,
      evidence: [callPath.length > 0 ? 'architecture_model' : 'service_map_dependency_fallback'],
    },
  }))
}

function renderCoreSequence(pathEdges: ArchitectureEdge[]): string {
  const lines: string[] = ['sequenceDiagram', '  autonumber']

  if (pathEdges.length === 0) {
    lines.push('  participant system as System')
    lines.push('  system->>system: Unknown flow (insufficient call/dependency evidence)')
    return `${lines.join('\n')}\n`
  }

  const participants = new Set<string>()
  for (const edge of pathEdges) {
    participants.add(edge.from.replace('service:', ''))
    participants.add(edge.to.replace('service:', ''))
  }

  for (const participant of [...participants].sort((a, b) => a.localeCompare(b))) {
    lines.push(`  participant ${participant.replace(/[^a-zA-Z0-9_]/g, '_')} as ${participant}`)
  }

  for (const edge of pathEdges) {
    const from = edge.from.replace('service:', '').replace(/[^a-zA-Z0-9_]/g, '_')
    const to = edge.to.replace('service:', '').replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`  ${from}->>${to}: ${edge.relation}`)
    lines.push(`  ${to}-->>${from}: response`)
  }

  return `${lines.join('\n')}\n`
}

function ensureRequiredDiagrams(
  context: ReadmeContext,
  db: Database.Database,
  cwd: string,
  writeEnabled: boolean,
): {generatedArchitecturePack: boolean; diagramSources: SourceRef[]} {
  const refs: SourceRef[] = []
  const threshold = context.staleThresholdHours

  const required = REQUIRED_DIAGRAM_NAMES.map((name) => path.join(context.diagrams.baseDir, name))

  const missing = required.filter((candidate) => !fileExists(candidate))
  let generatedArchitecturePack = false
  const autoGenerateMissing = context.config.diagram?.autoGenerateMissing ?? true

  if (writeEnabled && autoGenerateMissing && missing.length > 0) {
    generateArchitecturePack({
      mapId: context.mapId,
      db,
      cwd,
      depth: 'org',
    })
    generatedArchitecturePack = true
  }

  if (writeEnabled && autoGenerateMissing && !fileExists(context.diagrams.systemContext)) {
    writeTextFile(context.diagrams.systemContext, renderSystemContextDiagram(context.architectureModel))
  }

  if (writeEnabled && autoGenerateMissing && !fileExists(context.diagrams.serviceDependency)) {
    writeTextFile(context.diagrams.serviceDependency, renderServiceDependencyDiagram(context.serviceMap))
  }

  if (writeEnabled && autoGenerateMissing && !fileExists(context.diagrams.sequence)) {
    writeTextFile(context.diagrams.sequence, renderCoreSequence(context.coreRequestPath))
  }

  refs.push(
    sourceFromFile('diagram-system-context', 'System context diagram', context.diagrams.systemContext, cwd, threshold, context.now, true),
  )
  refs.push(
    sourceFromFile(
      'diagram-service-dependency',
      'Service dependency diagram',
      context.diagrams.serviceDependency,
      cwd,
      threshold,
      context.now,
      true,
    ),
  )
  refs.push(
    sourceFromFile('diagram-core-sequence', 'Core request flow sequence', context.diagrams.sequence, cwd, threshold, context.now, true),
  )
  refs.push(
    sourceFromFile(
      'diagram-c4-landscape',
      'Optional C4 system landscape',
      context.diagrams.optionalSystemLandscape,
      cwd,
      threshold,
      context.now,
      false,
    ),
  )
  refs.push(
    sourceFromFile(
      'diagram-c4-container',
      'Optional C4 container communication',
      context.diagrams.optionalContainer,
      cwd,
      threshold,
      context.now,
      false,
    ),
  )

  return {
    generatedArchitecturePack,
    diagramSources: refs,
  }
}

function readCodeownersOwner(repo: RepoRecord): string | undefined {
  if (!repo.localPath) {
    return undefined
  }

  const candidates = [path.join(repo.localPath, 'CODEOWNERS'), path.join(repo.localPath, '.github', 'CODEOWNERS')]

  for (const candidate of candidates) {
    if (!fileExists(candidate)) {
      continue
    }

    const lines = safeReadText(candidate)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))

    for (const line of lines) {
      const parts = line.split(/\s+/).filter((part) => part.length > 0)
      const owner = parts.find((part) => part.startsWith('@'))
      if (owner) {
        return owner
      }
    }
  }

  return undefined
}

function inferRuntimeFramework(repo: RepoRecord): string {
  if (!repo.localPath || !fileExists(repo.localPath)) {
    return 'Unknown'
  }

  const packagePath = path.join(repo.localPath, 'package.json')
  if (fileExists(packagePath)) {
    try {
      const payload = readJsonFile<{dependencies?: Record<string, string>; devDependencies?: Record<string, string>}>(packagePath)
      const deps = new Set<string>([
        ...Object.keys(payload.dependencies ?? {}),
        ...Object.keys(payload.devDependencies ?? {}),
      ])

      if (deps.has('next')) {
        return 'Node.js (Next.js)'
      }

      if (deps.has('nestjs') || deps.has('@nestjs/core')) {
        return 'Node.js (NestJS)'
      }

      if (deps.has('express')) {
        return 'Node.js (Express)'
      }

      return 'Node.js'
    } catch {
      return 'Node.js'
    }
  }

  if (fileExists(path.join(repo.localPath, 'pyproject.toml')) || fileExists(path.join(repo.localPath, 'requirements.txt'))) {
    return 'Python'
  }

  if (fileExists(path.join(repo.localPath, 'go.mod'))) {
    return 'Go'
  }

  if (fileExists(path.join(repo.localPath, 'Cargo.toml'))) {
    return 'Rust'
  }

  if (fileExists(path.join(repo.localPath, 'pom.xml')) || fileExists(path.join(repo.localPath, 'build.gradle'))) {
    return 'JVM'
  }

  return 'Unknown'
}

function inferDeployTarget(repo: RepoRecord): string {
  if (!repo.localPath || !fileExists(repo.localPath)) {
    return 'Unknown'
  }

  if (fileExists(path.join(repo.localPath, 'vercel.json'))) {
    return 'Vercel'
  }

  if (fileExists(path.join(repo.localPath, 'serverless.yml')) || fileExists(path.join(repo.localPath, 'serverless.yaml'))) {
    return 'Serverless'
  }

  const hasKubernetes =
    fileExists(path.join(repo.localPath, 'k8s')) ||
    fileExists(path.join(repo.localPath, 'helm')) ||
    fileExists(path.join(repo.localPath, 'charts'))

  if (hasKubernetes) {
    return 'Kubernetes'
  }

  if (fileExists(path.join(repo.localPath, 'Dockerfile')) || fileExists(path.join(repo.localPath, 'docker-compose.yml'))) {
    return 'Container'
  }

  return 'Unknown'
}

function formatList(values: string[]): string {
  if (values.length === 0) {
    return 'Unknown'
  }

  return values.join(', ')
}

function ownerForService(serviceId: string, context: ReadmeContext): string {
  const overrides = context.config.ownerTeamOverrides ?? {}
  if (overrides[serviceId]) {
    return overrides[serviceId]
  }

  const serviceNode = context.architectureModel.nodes.find((node) => node.id === `service:${serviceId}`)
  const fromMetadata = serviceNode?.metadata?.['owner']
  if (typeof fromMetadata === 'string' && fromMetadata.trim().length > 0) {
    return fromMetadata.trim()
  }

  const repo = context.repoMap.get(serviceId)
  if (!repo) {
    return 'Unknown'
  }

  const fromCodeowners = readCodeownersOwner(repo)
  return fromCodeowners ?? 'Unknown'
}

function criticalityForService(serviceId: string, context: ReadmeContext): string {
  const serviceNode = context.architectureModel.nodes.find((node) => node.id === `service:${serviceId}`)
  const criticality = serviceNode?.metadata?.['criticality']
  if (typeof criticality === 'string' && criticality.trim().length > 0) {
    return criticality
  }

  return 'Unknown'
}

function apiSurfaceForService(serviceId: string, context: ReadmeContext): string {
  const serviceContracts = context.contracts.filter((record) => record.repo === serviceId)
  if (serviceContracts.length === 0) {
    return 'Unknown'
  }

  const byType = new Map<string, number>()
  for (const contract of serviceContracts) {
    byType.set(contract.type, (byType.get(contract.type) ?? 0) + 1)
  }

  return [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, count]) => `${type} (${count})`)
    .join(', ')
}

function dependenciesForService(serviceId: string, context: ReadmeContext): string {
  const sourceId = `service:${serviceId}`
  const dependencies = context.serviceMap.edges
    .filter((edge) => edge.from === sourceId && edge.to.startsWith('service:'))
    .map((edge) => edge.to.replace('service:', ''))

  return formatList([...new Set(dependencies)].sort((a, b) => a.localeCompare(b)))
}

function datastoresForService(serviceId: string, context: ReadmeContext): string {
  const sourceId = `service:${serviceId}`
  const stores = context.architectureModel.edges
    .filter((edge) => edge.from === sourceId && edge.to.startsWith('datastore:'))
    .map((edge) => edge.to.replace('datastore:', ''))

  return formatList([...new Set(stores)].sort((a, b) => a.localeCompare(b)))
}

function statusForService(serviceId: string, context: ReadmeContext): string {
  const repo = context.repoMap.get(serviceId)
  if (!repo) {
    return 'Unknown'
  }

  if (repo.archived) {
    return 'Archived'
  }

  return 'Active'
}

function domainForRepo(repoName: string, config: ReadmeConfig): string {
  const groups = config.domainGroups ?? []
  for (const group of groups) {
    if (group.match.some((pattern) => repoName.toLowerCase().includes(pattern.toLowerCase()))) {
      return group.name
    }
  }

  return 'Ungrouped'
}

function serviceCatalog(context: ReadmeContext): ServiceCatalogRow[] {
  const serviceIds = context.selectedRepos
    .filter((repo) => context.serviceMap.nodes.some((node) => node.id === `service:${repo}`))
    .sort((a, b) => a.localeCompare(b))

  return serviceIds.map((serviceId) => {
    const repo = context.repoMap.get(serviceId)
    return {
      serviceName: serviceId,
      repository: repo?.fullName ?? serviceId,
      ownerTeam: ownerForService(serviceId, context),
      runtime: repo ? inferRuntimeFramework(repo) : 'Unknown',
      apiEventSurface: apiSurfaceForService(serviceId, context),
      dependencies: dependenciesForService(serviceId, context),
      dataStores: datastoresForService(serviceId, context),
      deployTarget: repo ? inferDeployTarget(repo) : 'Unknown',
      tier: criticalityForService(serviceId, context),
      status: statusForService(serviceId, context),
    }
  })
}

function resolveSectionSources(section: SectionPayload, sources: SourceRef[]): SourceRef[] {
  const ids = new Set(section.sourceIds)
  return sources
    .filter((source) => ids.has(source.id))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function renderSourceBlock(sourceRefs: SourceRef[]): string[] {
  const lines: string[] = ['### Sources', '']
  if (sourceRefs.length === 0) {
    lines.push('- Unknown')
    lines.push('')
    return lines
  }

  for (const source of sourceRefs) {
    const generated = source.generatedAt ?? 'Unknown'
    const freshness = source.stale ? 'stale' : 'fresh'
    const suffix = source.note ? ` (${source.note})` : ''
    lines.push(`- ${source.label}: \`${source.path}\` (generated: ${generated}, ${freshness})${suffix}`)
  }
  lines.push('')
  return lines
}

function renderStaleWarning(sourceRefs: SourceRef[]): string[] {
  const stale = sourceRefs.filter((source) => source.required && (source.stale || !source.exists))
  if (stale.length === 0) {
    return []
  }

  const lines = ['> [!WARNING]', '> Stale or missing source data detected for this section:', ...stale.map((source) => `> - ${source.label}`), '']
  return lines
}

function defaultManualBlockText(sectionId: ReadmeSectionId): string {
  return `\nAdd team-specific notes for \`${sectionId}\` here.\n`
}

function extractManualBlocks(existingContent: string): Map<ReadmeSectionId, string> {
  const out = new Map<ReadmeSectionId, string>()
  for (const sectionId of README_SECTION_ORDER) {
    const escaped = sectionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(
      `<!-- SDX:SECTION:${escaped}:MANUAL:START -->([\\s\\S]*?)<!-- SDX:SECTION:${escaped}:MANUAL:END -->`,
      'm',
    )
    const match = existingContent.match(regex)
    if (match) {
      out.set(sectionId, match[1])
    }
  }
  return out
}

function renderSection(section: SectionPayload, sources: SourceRef[], manualContent: string | undefined): string {
  const lines: string[] = []
  lines.push(`<!-- SDX:SECTION:${section.id}:START -->`)
  lines.push(`## ${section.title}`)
  lines.push('')
  lines.push(...section.body)
  lines.push('')
  const sourceRefs = resolveSectionSources(section, sources)
  lines.push(...renderStaleWarning(sourceRefs))
  lines.push(...renderSourceBlock(sourceRefs))
  const manualBody = manualContent ?? defaultManualBlockText(section.id)
  lines.push(`<!-- SDX:SECTION:${section.id}:MANUAL:START -->${manualBody}<!-- SDX:SECTION:${section.id}:MANUAL:END -->`)
  lines.push(`<!-- SDX:SECTION:${section.id}:END -->`)
  lines.push('')
  return lines.join('\n')
}

function splitLines(input: string): string[] {
  const normalized = input.replace(/\r\n/g, '\n')
  if (normalized.length === 0) {
    return []
  }

  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function diffLines(oldLines: string[], newLines: string[]): Array<{type: 'equal' | 'add' | 'remove'; line: string}> {
  const n = oldLines.length
  const m = newLines.length

  const dp: number[][] = Array.from({length: n + 1}, () => Array<number>(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const ops: Array<{type: 'equal' | 'add' | 'remove'; line: string}> = []
  let i = 0
  let j = 0

  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({type: 'equal', line: oldLines[i]})
      i += 1
      j += 1
      continue
    }

    if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({type: 'remove', line: oldLines[i]})
      i += 1
    } else {
      ops.push({type: 'add', line: newLines[j]})
      j += 1
    }
  }

  while (i < n) {
    ops.push({type: 'remove', line: oldLines[i]})
    i += 1
  }

  while (j < m) {
    ops.push({type: 'add', line: newLines[j]})
    j += 1
  }

  return ops
}

function unifiedDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): string {
  if (oldText === newText) {
    return ''
  }

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const ops = diffLines(oldLines, newLines)
  const context = 3

  const hunks: Array<{start: number; end: number}> = []
  let current: {start: number; end: number} | undefined

  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type === 'equal') {
      continue
    }

    const hunkStart = Math.max(0, index - context)
    const hunkEnd = Math.min(ops.length, index + context + 1)

    if (!current) {
      current = {start: hunkStart, end: hunkEnd}
      continue
    }

    if (hunkStart <= current.end) {
      current.end = Math.max(current.end, hunkEnd)
    } else {
      hunks.push(current)
      current = {start: hunkStart, end: hunkEnd}
    }
  }

  if (current) {
    hunks.push(current)
  }

  const oldPrefix: number[] = [0]
  const newPrefix: number[] = [0]
  for (const op of ops) {
    const oldCount = oldPrefix[oldPrefix.length - 1] + (op.type === 'add' ? 0 : 1)
    const newCount = newPrefix[newPrefix.length - 1] + (op.type === 'remove' ? 0 : 1)
    oldPrefix.push(oldCount)
    newPrefix.push(newCount)
  }

  const lines: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`]

  for (const hunk of hunks) {
    const slice = ops.slice(hunk.start, hunk.end)
    const oldStart = oldPrefix[hunk.start] + 1
    const newStart = newPrefix[hunk.start] + 1
    const oldLen = slice.filter((entry) => entry.type !== 'add').length
    const newLen = slice.filter((entry) => entry.type !== 'remove').length

    lines.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`)

    for (const op of slice) {
      if (op.type === 'equal') {
        lines.push(` ${op.line}`)
      } else if (op.type === 'remove') {
        lines.push(`-${op.line}`)
      } else {
        lines.push(`+${op.line}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

function buildReadmeContext(
  mapId: string,
  db: Database.Database,
  cwd: string,
  outputPath: string,
  config: ReadmeConfig,
): ReadmeContext {
  const now = new Date()
  const threshold = config.staleThresholdHours ?? 72

  const scope = loadScopeManifest(mapId, cwd)
  const repos = listAllRepos(db)
  const repoMap = new Map(repos.map((repo) => [repo.name, repo]))
  const selectedRepos = filterReposForReadme(scope, config)

  const mapDir = path.join(cwd, 'maps', mapId)
  const serviceMap = loadServiceMap(mapId, scope, repoMap, mapDir)
  const contracts = loadContracts(mapId, scope, repoMap, mapDir)
  const model = loadArchitectureModel(mapId, db, cwd)
  const diagrams = diagramPaths(mapId, cwd)

  const sourceRefs: SourceRef[] = []
  sourceRefs.push(sourceFromFile('scope', 'Map scope manifest', path.join(mapDir, 'scope.json'), cwd, threshold, now, true))
  sourceRefs.push(sourceFromFile('service-map-json', 'Service map JSON', path.join(mapDir, 'service-map.json'), cwd, threshold, now, true))
  sourceRefs.push(sourceFromFile('service-map-md', 'Service map Markdown', path.join(mapDir, 'service-map.md'), cwd, threshold, now, false))
  sourceRefs.push(sourceFromFile('service-map-mmd', 'Service map Mermaid', path.join(mapDir, 'service-map.mmd'), cwd, threshold, now, false))
  sourceRefs.push(sourceFromFile('contracts-json', 'Contracts JSON', path.join(mapDir, 'contracts.json'), cwd, threshold, now, true))
  sourceRefs.push(sourceFromFile('contracts-md', 'Contracts Markdown', path.join(mapDir, 'contracts.md'), cwd, threshold, now, false))
  sourceRefs.push(
    sourceFromFile('docs-architecture', 'Generated architecture doc', path.join(cwd, 'docs', 'architecture', `${mapId}.md`), cwd, threshold, now, false),
  )
  sourceRefs.push(
    sourceFromFile(
      'docs-dependencies',
      'Generated dependency summary',
      path.join(cwd, 'catalog', 'dependencies', `${mapId}.md`),
      cwd,
      threshold,
      now,
      false,
    ),
  )
  sourceRefs.push(
    sourceFromFile(
      'architecture-model',
      'Architecture model',
      path.join(cwd, 'maps', mapId, 'architecture', 'model.json'),
      cwd,
      threshold,
      now,
      false,
    ),
  )
  sourceRefs.push(
    sourceFromFile(
      'architecture-validation',
      'Architecture validation',
      path.join(cwd, 'maps', mapId, 'architecture', 'validation.json'),
      cwd,
      threshold,
      now,
      false,
    ),
  )
  sourceRefs.push(sourceFromRepoSync(repos, selectedRepos, threshold, now))

  return {
    cwd,
    mapId,
    scope,
    selectedRepos,
    repoMap,
    serviceMap,
    contracts,
    architectureModel: model,
    diagrams,
    sources: sourceRefs,
    staleThresholdHours: threshold,
    now,
    outputPath,
    config,
    sourceSnapshotAt: computeSnapshotTimestamp(sourceRefs, now),
    coreRequestPath: findCoreRequestPath(model, serviceMap),
    sourceRepoSyncAt: sourceRefs.find((source) => source.id === 'repo-sync')?.generatedAt,
  }
}

function buildSections(context: ReadmeContext): SectionPayload[] {
  const outputPath = context.outputPath
  const includeC4Links = context.config.diagram?.includeC4Links ?? true
  const links = {
    systemContext: toLinkPath(context.diagrams.systemContext, outputPath),
    serviceDependency: toLinkPath(context.diagrams.serviceDependency, outputPath),
    sequence: toLinkPath(context.diagrams.sequence, outputPath),
    optionalSystemLandscape: toLinkPath(context.diagrams.optionalSystemLandscape, outputPath),
    optionalContainer: toLinkPath(context.diagrams.optionalContainer, outputPath),
    optionalArchitectureIndex: toLinkPath(context.diagrams.optionalArchitectureIndex, outputPath),
  }

  const catalogRows = serviceCatalog(context)
  const asyncContracts = context.contracts.filter((record) => record.type === 'asyncapi')

  const repoRows = context.selectedRepos.map((repoName) => {
    const repo = context.repoMap.get(repoName)
    return {
      name: repoName,
      fullName: repo?.fullName ?? repoName,
      owner: ownerForService(repoName, context),
      source: repo?.source ?? 'Unknown',
      branch: repo?.defaultBranch ?? 'Unknown',
      localPath: repo?.localPath ?? 'Unknown',
      domain: domainForRepo(repoName, context.config),
    }
  })

  const datastoreNodes = context.architectureModel.nodes.filter((node) => node.type === 'datastore')
  const adrDir = path.join(context.cwd, 'docs', 'adr')
  const adrFiles = fileExists(adrDir)
    ? fs
        .readdirSync(adrDir, {withFileTypes: true})
        .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b))
    : []

  const coreFlowLines =
    context.coreRequestPath.length > 0
      ? context.coreRequestPath.map((edge) => {
          const from = edge.from.replace('service:', '')
          const to = edge.to.replace('service:', '')
          return `- ${from} -> ${to} (confidence ${edge.provenance.confidence.toFixed(2)})`
        })
      : ['- Unknown']

  const sectionById: Record<ReadmeSectionId, SectionPayload> = {
    what_is_this_system: {
      id: 'what_is_this_system',
      title: SECTION_TITLES['what_is_this_system'],
      body: [
        context.config.customIntro ??
          'This README is generated by SDX as the canonical architecture onboarding guide for this org workspace.',
        '',
        `- Organization: \`${context.scope.org}\``,
        `- Map: \`${context.mapId}\``,
        `- Repositories selected for this README: ${context.selectedRepos.length}`,
        `- Services detected: ${catalogRows.length}`,
      ],
      sourceIds: ['scope', 'repo-sync', 'service-map-json'],
    },
    architecture_glance: {
      id: 'architecture_glance',
      title: SECTION_TITLES['architecture_glance'],
      body: (() => {
        const lines = [
        `- [System context diagram](${links.systemContext})`,
        `- [Service dependency graph](${links.serviceDependency})`,
        `- [Core request flow sequence](${links.sequence})`,
        fileExists(context.diagrams.optionalArchitectureIndex)
          ? `- [Architecture pack index](${links.optionalArchitectureIndex})`
          : '- Architecture pack index: Not available',
        ]

        if (includeC4Links) {
          lines.push(
            fileExists(context.diagrams.optionalSystemLandscape)
              ? `- [Optional C4 landscape](${links.optionalSystemLandscape})`
              : '- Optional C4 landscape: Not available',
          )
          lines.push(
            fileExists(context.diagrams.optionalContainer)
              ? `- [Optional C4 container](${links.optionalContainer})`
              : '- Optional C4 container: Not available',
          )
        }

        return lines
      })(),
      sourceIds: [
        'service-map-json',
        'architecture-model',
        'diagram-system-context',
        'diagram-service-dependency',
        'diagram-core-sequence',
        'diagram-c4-landscape',
        'diagram-c4-container',
      ],
    },
    service_catalog: {
      id: 'service_catalog',
      title: SECTION_TITLES['service_catalog'],
      body: [
        '| Service name | Repository | Owner/team | Runtime/framework | API/event surface | Dependencies | Data stores | Deploy target | Tier/criticality | Status |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...(catalogRows.length > 0
          ? catalogRows.map(
              (row) =>
                `| ${row.serviceName} | ${row.repository} | ${row.ownerTeam} | ${row.runtime} | ${row.apiEventSurface} | ${row.dependencies} | ${row.dataStores} | ${row.deployTarget} | ${row.tier} | ${row.status} |`,
            )
          : ['| Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |']),
      ],
      sourceIds: ['service-map-json', 'contracts-json', 'architecture-model', 'repo-sync'],
    },
    critical_flows: {
      id: 'critical_flows',
      title: SECTION_TITLES['critical_flows'],
      body: [
        `- Primary sequence diagram: [core-request-flow.mmd](${links.sequence})`,
        '- Highest-confidence path:',
        ...coreFlowLines,
      ],
      sourceIds: ['architecture-model', 'service-map-json', 'docs-dependencies', 'diagram-core-sequence'],
    },
    event_async_topology: {
      id: 'event_async_topology',
      title: SECTION_TITLES['event_async_topology'],
      body: [
        '| Contract | Repository | Version | Compatibility | Producers | Consumers |',
        '|---|---|---|---|---|---|',
        ...(asyncContracts.length > 0
          ? asyncContracts.map(
              (record) =>
                `| ${record.path} | ${record.repo} | ${record.version ?? 'Unknown'} | ${record.compatibilityStatus} | ${formatList(record.producers)} | ${formatList(record.consumers)} |`,
            )
          : ['| Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |']),
      ],
      sourceIds: ['contracts-json', 'architecture-model'],
    },
    contracts_index: {
      id: 'contracts_index',
      title: SECTION_TITLES['contracts_index'],
      body: [
        '| Repository | Type | Path | Version | Compatibility |',
        '|---|---|---|---|---|',
        ...(context.contracts.length > 0
          ? context.contracts.map(
              (record) =>
                `| ${record.repo} | ${record.type} | ${record.path} | ${record.version ?? 'Unknown'} | ${record.compatibilityStatus} |`,
            )
          : ['| Unknown | Unknown | Unknown | Unknown | Unknown |']),
      ],
      sourceIds: ['contracts-json', 'contracts-md'],
    },
    repository_index: {
      id: 'repository_index',
      title: SECTION_TITLES['repository_index'],
      body: [
        '| Repository | Owner/team | Domain | Source | Default branch | Local path |',
        '|---|---|---|---|---|---|',
        ...(repoRows.length > 0
          ? repoRows.map(
              (row) =>
                `| ${row.fullName} | ${row.owner} | ${row.domain} | ${row.source} | ${row.branch} | ${row.localPath.replace(/\|/g, '\\|')} |`,
            )
          : ['| Unknown | Unknown | Unknown | Unknown | Unknown | Unknown |']),
      ],
      sourceIds: ['scope', 'repo-sync'],
    },
    environments_deployment: {
      id: 'environments_deployment',
      title: SECTION_TITLES['environments_deployment'],
      body: [
        '| Service | Deploy target | Runtime/framework | Environment notes |',
        '|---|---|---|---|',
        ...(catalogRows.length > 0
          ? catalogRows.map(
              (row) =>
                `| ${row.serviceName} | ${row.deployTarget} | ${row.runtime} | ${row.deployTarget === 'Unknown' ? 'Unknown' : 'Validate env parity in deployment pipeline'} |`,
            )
          : ['| Unknown | Unknown | Unknown | Unknown |']),
      ],
      sourceIds: ['service-map-json', 'repo-sync', 'architecture-model'],
    },
    data_stores_boundaries: {
      id: 'data_stores_boundaries',
      title: SECTION_TITLES['data_stores_boundaries'],
      body: [
        '| Data store | Depending services | Boundary notes |',
        '|---|---|---|',
        ...(datastoreNodes.length > 0
          ? datastoreNodes
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((node) => {
                const dependers = context.architectureModel.edges
                  .filter((edge) => edge.to === node.id && edge.from.startsWith('service:'))
                  .map((edge) => edge.from.replace('service:', ''))
                  .sort((a, b) => a.localeCompare(b))
                return `| ${node.label} | ${formatList([...new Set(dependers)])} | ${String(node.metadata?.['boundary'] ?? 'Unknown')} |`
              })
          : ['| Unknown | Unknown | Unknown |']),
      ],
      sourceIds: ['architecture-model'],
    },
    security_compliance: {
      id: 'security_compliance',
      title: SECTION_TITLES['security_compliance'],
      body: [
        '- Authentication/authorization model: Unknown',
        '- Data classification posture: Unknown',
        '- Compliance scope (SOC2/PCI/HIPAA/etc.): Unknown',
        '- Secret management baseline: Unknown',
        '- Required action: populate this section via manual block with org security standards.',
      ],
      sourceIds: ['architecture-model', 'contracts-json'],
    },
    local_dev_contribution: {
      id: 'local_dev_contribution',
      title: SECTION_TITLES['local_dev_contribution'],
      body: [
        '```bash',
        './scripts/sdx status',
        `./scripts/sdx map build ${context.mapId}`,
        `./scripts/sdx contracts extract --map ${context.mapId}`,
        `./scripts/sdx docs generate --map ${context.mapId}`,
        `./scripts/sdx docs readme --map ${context.mapId}`,
        '```',
        '',
        '- Use `--check` in CI to enforce freshness and deterministic output.',
      ],
      sourceIds: ['scope', 'service-map-json', 'contracts-json'],
    },
    runbooks_escalation: {
      id: 'runbooks_escalation',
      title: SECTION_TITLES['runbooks_escalation'],
      body: [
        '- Runbook root: `docs/runbooks/` (Unknown if not present)',
        '- Escalation path: Unknown',
        '- Incident channel: Unknown',
        '- Required action: populate escalation ownership in manual block.',
      ],
      sourceIds: ['architecture-model', 'repo-sync'],
    },
    adr_index: {
      id: 'adr_index',
      title: SECTION_TITLES['adr_index'],
      body: [
        ...(adrFiles.length > 0
          ? adrFiles.map((fileName) => `- [${fileName}](./docs/adr/${fileName})`)
          : ['- Unknown (no ADR markdown files found under `docs/adr/`)']),
      ],
      sourceIds: ['docs-architecture'],
    },
    glossary: {
      id: 'glossary',
      title: SECTION_TITLES['glossary'],
      body: [
        '- **Service**: A deployable unit represented by a repository in the selected map scope.',
        '- **Contract**: API/event interface artifact (OpenAPI, GraphQL, Protobuf, AsyncAPI).',
        '- **Map**: A named SDX scope manifest that defines discovered/included/excluded repos.',
        '- **Override**: Manual architecture hints in `maps/<map-id>/architecture-overrides.json`.',
        '- **Unknown**: Field not currently derivable from SDX artifacts; requires manual completion.',
      ],
      sourceIds: ['scope', 'service-map-json', 'contracts-json', 'architecture-model'],
    },
    changelog_metadata: {
      id: 'changelog_metadata',
      title: SECTION_TITLES['changelog_metadata'],
      body: [
        `- Generated timestamp: ${context.sourceSnapshotAt}`,
        `- Map id: ${context.mapId}`,
        `- Schema version: ${SCHEMA_VERSION}`,
        `- CLI version: ${getCliPackageVersion()}`,
        `- Freshness threshold (hours): ${context.staleThresholdHours}`,
        `- Repo sync baseline: ${context.sourceRepoSyncAt ?? 'Unknown'}`,
        '- Source refs used:',
        ...context.sources.map((source) => `  - ${source.label}: \`${source.path}\``),
      ],
      sourceIds: context.sources.map((source) => source.id),
    },
  }

  return README_SECTION_ORDER.map((sectionId) => sectionById[sectionId])
}

function renderReadme(sections: SectionPayload[], context: ReadmeContext, existingContent: string): RenderOutput {
  const manualBlocks = extractManualBlocks(existingContent)

  const lines: string[] = [
    '# SDX Organization Architecture Workspace',
    '',
    `> Generated for org \`${context.scope.org}\` using map \`${context.mapId}\`.`,
    '',
    `> Source snapshot timestamp: ${context.sourceSnapshotAt}`,
    '',
  ]

  for (const section of sections) {
    const manual = manualBlocks.get(section.id)
    lines.push(renderSection(section, context.sources, manual))
  }

  return {
    content: `${lines.join('\n').trimEnd()}\n`,
    sourceRefs: context.sources,
  }
}

function checkFailures(
  existingContent: string,
  renderedContent: string,
  sources: SourceRef[],
): {
  stale: SourceRef[]
  missing: SourceRef[]
  changed: boolean
} {
  const stale = sources.filter((source) => source.required && source.stale)
  const missing = sources.filter((source) => source.required && !source.exists)
  const changed = existingContent !== renderedContent

  return {stale, missing, changed}
}

function summarizeResult(
  outputPath: string,
  staleSources: SourceRef[],
  missingSources: SourceRef[],
  changed: boolean,
  checkMode: boolean,
): string {
  const lines = [`README output: ${outputPath}`]
  lines.push(`Content changed: ${changed ? 'yes' : 'no'}`)
  lines.push(`Stale sources: ${staleSources.length}`)
  lines.push(`Missing required sources: ${missingSources.length}`)

  if (staleSources.length > 0) {
    lines.push(`Stale source labels: ${staleSources.map((source) => source.label).join(', ')}`)
  }

  if (missingSources.length > 0) {
    lines.push(`Missing source labels: ${missingSources.map((source) => source.label).join(', ')}`)
  }

  if (checkMode) {
    const failed = staleSources.length > 0 || missingSources.length > 0 || changed
    lines.push(`Check result: ${failed ? 'FAIL' : 'PASS'}`)
  }

  return lines.join('\n')
}

export function generateReadme(options: GenerateReadmeOptions): GenerateReadmeResult {
  const cwd = options.cwd ?? process.cwd()
  const outputPath = path.resolve(cwd, options.output ?? 'README.md')
  const includeSections = options.includeSections ?? []
  const excludeSections = options.excludeSections ?? []

  if (options.check && options.dryRun) {
    throw new Error('Use either --check or --dry-run, not both.')
  }

  const {config, sourcePath} = loadReadmeConfig(cwd)
  const selectedSections = selectSections(config, includeSections, excludeSections)

  const context = buildReadmeContext(options.mapId, options.db, cwd, outputPath, config)

  if (sourcePath) {
    context.sources.push(
      sourceFromFile('readme-config', 'README config', sourcePath, cwd, context.staleThresholdHours, context.now, false),
    )
  }

  const writeEnabled = !options.check && !options.dryRun
  const diagramResult = ensureRequiredDiagrams(context, options.db, cwd, writeEnabled)
  context.sources.push(...diagramResult.diagramSources)
  upsertSourceRef(
    context.sources,
    sourceFromFile(
      'docs-architecture',
      'Generated architecture doc',
      path.join(cwd, 'docs', 'architecture', `${options.mapId}.md`),
      cwd,
      context.staleThresholdHours,
      context.now,
      false,
    ),
  )
  upsertSourceRef(
    context.sources,
    sourceFromFile(
      'architecture-model',
      'Architecture model',
      path.join(cwd, 'maps', options.mapId, 'architecture', 'model.json'),
      cwd,
      context.staleThresholdHours,
      context.now,
      false,
    ),
  )
  upsertSourceRef(
    context.sources,
    sourceFromFile(
      'architecture-validation',
      'Architecture validation',
      path.join(cwd, 'maps', options.mapId, 'architecture', 'validation.json'),
      cwd,
      context.staleThresholdHours,
      context.now,
      false,
    ),
  )
  context.sourceSnapshotAt = computeSnapshotTimestamp(context.sources, context.now)

  const orderedSections = buildSections(context).filter((section) => selectedSections.includes(section.id))

  const existingContent = safeReadText(outputPath)
  const rendered = renderReadme(orderedSections, context, existingContent)

  const {stale, missing, changed} = checkFailures(existingContent, rendered.content, rendered.sourceRefs)
  const shouldWrite = writeEnabled && changed

  if (shouldWrite) {
    writeTextFile(outputPath, rendered.content)
  }

  const diff = options.dryRun || (options.check && changed)
    ? unifiedDiff(existingContent, rendered.content, `${asRelative(outputPath, cwd)}.current`, `${asRelative(outputPath, cwd)}.next`)
    : undefined

  const checkPassed = !options.check || (stale.length === 0 && missing.length === 0 && !changed)

  return {
    outputPath,
    sections: selectedSections,
    stale: stale.length > 0,
    staleSources: stale,
    missingSources: missing,
    changed,
    wroteFile: shouldWrite,
    checkPassed,
    summary: summarizeResult(outputPath, stale, missing, changed, Boolean(options.check)),
    diff,
  }
}
