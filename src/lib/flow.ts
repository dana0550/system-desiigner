import path from 'node:path'
import Database from 'better-sqlite3'
import YAML from 'yaml'
import {z} from 'zod'
import {SCHEMA_VERSION} from './constants'
import {extractContracts} from './contracts'
import {listFilesRecursive} from './fileScan'
import {ensureDir, fileExists, readJsonFile, safeReadText, writeJsonFile, writeTextFile} from './fs'
import {getMapDir} from './paths'
import {listAllRepos} from './repoRegistry'
import {loadScopeManifest} from './scope'
import {
  ContractRecord,
  EndpointInventoryRecord,
  FlowCheckResult,
  FlowEdge,
  FlowEdgeType,
  FlowEnvironment,
  FlowFinding,
  FlowFindingsArtifact,
  FlowGraphArtifact,
  FlowJourney,
  FlowJourneysArtifact,
  FlowNode,
  FlowValidationResult,
  RepoRecord,
} from './types'

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|dart)$/i
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const
const DATASTORE_KEYWORDS = ['postgres', 'mysql', 'mongodb', 'dynamodb', 'cassandra', 'sqlite'] as const
const CACHE_KEYWORDS = ['redis', 'memcached'] as const
const EVENT_HINTS = ['kafka', 'topic', 'pubsub', 'event', 'sqs', 'sns', 'rabbitmq', 'nats', 'pulsar'] as const

const FLOW_CONFIG_SCHEMA = z.object({
  endpointPatterns: z
    .object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  serviceAliases: z.record(z.string(), z.string()).optional(),
  serviceOwnershipOverrides: z.record(z.string(), z.string()).optional(),
  ignoreEndpoints: z.array(z.string()).optional(),
  ignoredFindings: z.array(z.string()).optional(),
  externalDependencyAliases: z.record(z.string(), z.string()).optional(),
  runtime: z
    .object({
      staleThresholdHours: z.number().positive().optional(),
      pathsByEnv: z
        .object({
          dev: z.string().optional(),
          staging: z.string().optional(),
          prod: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  journeys: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        steps: z.array(z.string()).optional(),
        start: z.string().optional(),
        end: z.string().optional(),
      }),
    )
    .optional(),
})

const FLOW_OVERRIDES_SCHEMA = z.object({
  schemaVersion: z.string().optional(),
  generatedAt: z.string().optional(),
  mapId: z.string().optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  serviceOwnership: z.record(z.string(), z.string()).optional(),
  assertedEdges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(['http_call', 'grpc_call', 'async_publish', 'async_consume', 'db_read', 'db_write', 'cache_read', 'cache_write']),
        protocol: z.string().optional(),
        auth: z.string().optional(),
      }),
    )
    .optional(),
  suppressedEdges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(['http_call', 'grpc_call', 'async_publish', 'async_consume', 'db_read', 'db_write', 'cache_read', 'cache_write']),
      }),
    )
    .optional(),
})

export interface FlowConfig {
  endpointPatterns?: {
    include?: string[]
    exclude?: string[]
  }
  serviceAliases?: Record<string, string>
  serviceOwnershipOverrides?: Record<string, string>
  ignoreEndpoints?: string[]
  ignoredFindings?: string[]
  externalDependencyAliases?: Record<string, string>
  runtime?: {
    staleThresholdHours?: number
    pathsByEnv?: Partial<Record<FlowEnvironment, string>>
  }
  journeys?: Array<{
    name: string
    description?: string
    steps?: string[]
    start?: string
    end?: string
  }>
}

interface FlowOverrides {
  schemaVersion: string
  generatedAt: string
  mapId: string
  aliases: Record<string, string>
  serviceOwnership: Record<string, string>
  assertedEdges: Array<{
    from: string
    to: string
    type: FlowEdgeType
    protocol?: string
    auth?: string
  }>
  suppressedEdges: Array<{
    from: string
    to: string
    type: FlowEdgeType
  }>
}

interface ContractOperation {
  service: string
  method: string
  path: string
  schemaRef: string
}

interface ContractChannel {
  service: string
  channel: string
  schemaRef: string
}

interface RuntimeRecord {
  env: FlowEnvironment
  serviceName?: string
  method?: string
  path?: string
  url?: string
  protocol?: string
  peerService?: string
  messagingDestination?: string
  dbSystem?: string
  dbOperation?: string
  timestamp?: string
  evidenceRef: string
}

interface RawCallSite {
  callerService: string
  callerKind: 'client' | 'service'
  method: string
  targetRaw: string
  sourceFile: string
  sourceLine: number
  protocol: 'http' | 'grpc'
  timeoutMs?: number
  retryPolicy?: string
}

interface RawEventSignal {
  service: string
  direction: 'publish' | 'consume'
  topic: string
  sourceFile: string
  sourceLine: number
}

interface RawStoreSignal {
  service: string
  store: string
  type: 'db_read' | 'db_write' | 'cache_read' | 'cache_write'
  sourceFile: string
  sourceLine: number
}

interface EdgeAccumulator {
  type: FlowEdgeType
  from: string
  to: string
  protocol: string
  auth: string
  payloadSchemaRef?: string
  piiTags: Set<string>
  evidenceRefs: Set<string>
  lastSeenByEnv: Partial<Record<FlowEnvironment, string>>
  hasStatic: boolean
  hasRuntime: boolean
  hasOverride: boolean
  runtimeByEnv: Set<FlowEnvironment>
}

export interface FlowDiscoverOptions {
  mapId: string
  db: Database.Database
  cwd?: string
  env?: FlowEnvironment | 'all'
  runtimeDir?: string
  dryRun?: boolean
}

export interface FlowDiscoverResult {
  mapId: string
  generatedAt: string
  graphPath: string
  endpointsPath: string
  findingsPath: string
  journeysPath: string
  graph: FlowGraphArtifact
  endpoints: EndpointInventoryRecord[]
  findings: FlowFindingsArtifact
  journeys: FlowJourneysArtifact
}

export interface FlowValidateOptions {
  mapId: string
  db: Database.Database
  cwd?: string
}

export interface FlowDiagramOptions {
  mapId: string
  cwd?: string
  journey?: string
  outputDir?: string
}

export interface FlowDiagramResult {
  outputDir: string
  endpointCommunicationPath: string
  clientBackendPath: string
  eventLineagePath: string
  journeyPaths: string[]
}

export interface FlowCheckOptions {
  mapId: string
  db: Database.Database
  cwd?: string
  env?: FlowEnvironment | 'all'
  runtimeDir?: string
}

export interface LoadedFlowArtifacts {
  graph?: FlowGraphArtifact
  endpoints?: EndpointInventoryRecord[]
  findings?: FlowFindingsArtifact
  journeys?: FlowJourneysArtifact
}

function normalizePathForMatch(input: string): string {
  const withoutQuery = input.split('?')[0].split('#')[0]
  const trimmed = withoutQuery.trim()
  if (trimmed.length === 0) {
    return '/'
  }

  const standardized = trimmed
    .replace(/\/+/g, '/')
    .replace(/:[A-Za-z0-9_]+/g, '{id}')
    .replace(/[0-9a-fA-F-]{8,}/g, '{id}')

  const withLeading = standardized.startsWith('/') ? standardized : `/${standardized}`
  return withLeading.replace(/\/$/, '') || '/'
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function endpointIdFor(service: string, method: string, endpointPath: string): string {
  const normalizedPath = normalizePathForMatch(endpointPath)
  return `endpoint:${service}:${method.toUpperCase()}:${stableHash(`${service}|${method.toUpperCase()}|${normalizedPath}`)}`
}

function sanitizeLabel(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function lineFromIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

function toRelative(filePath: string, cwd: string): string {
  return path.relative(cwd, filePath).replaceAll(path.sep, '/')
}

function quoteTrim(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fileExists(filePath)) {
    return out
  }

  for (const line of safeReadText(filePath).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const idx = trimmed.indexOf('=')
    if (idx === -1) {
      continue
    }

    const key = trimmed.slice(0, idx).trim()
    const value = quoteTrim(trimmed.slice(idx + 1).trim())
    if (key.length > 0) {
      out[key] = value
    }
  }

  return out
}

function collectRepoEnv(repo: RepoRecord): Record<string, string> {
  if (!repo.localPath || !fileExists(repo.localPath)) {
    return {}
  }

  const candidates = ['.env', '.env.local', '.env.development', '.env.staging', '.env.production']
  const out: Record<string, string> = {}

  for (const candidate of candidates) {
    Object.assign(out, parseEnvFile(path.join(repo.localPath, candidate)))
  }

  return out
}

function parsePackageDependencySet(repoPath: string): Set<string> {
  const pkgPath = path.join(repoPath, 'package.json')
  if (!fileExists(pkgPath)) {
    return new Set()
  }

  try {
    const data = readJsonFile<{
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }>(pkgPath)

    return new Set([
      ...Object.keys(data.dependencies ?? {}),
      ...Object.keys(data.devDependencies ?? {}),
      ...Object.keys(data.peerDependencies ?? {}),
    ])
  } catch {
    return new Set()
  }
}

function hasAnyPath(root: string, candidates: string[]): boolean {
  return candidates.some((candidate) => fileExists(path.join(root, candidate)))
}

function inferRepoKind(repo: RepoRecord): 'client' | 'service' {
  if (!repo.localPath || !fileExists(repo.localPath)) {
    return 'service'
  }

  const lowerName = repo.name.toLowerCase()
  if (lowerName.includes('api') || lowerName.includes('backend') || lowerName.includes('service')) {
    return 'service'
  }

  const deps = parsePackageDependencySet(repo.localPath)
  const serviceHints = ['express', 'fastify', '@nestjs/core', 'nestjs', 'koa', 'hapi']
  if (serviceHints.some((dep) => deps.has(dep))) {
    return 'service'
  }

  if (deps.has('next')) {
    const nextApiPaths = [
      'app/api',
      'src/app/api',
      'pages/api',
      'src/pages/api',
      'server.ts',
      'server.js',
      'src/server.ts',
      'src/server.js',
    ]
    if (hasAnyPath(repo.localPath, nextApiPaths)) {
      return 'service'
    }
  }

  const clientHints = ['react', 'react-native', 'expo', 'next', 'vue', 'svelte', 'flutter', 'swiftui']
  if (clientHints.some((dep) => deps.has(dep))) {
    return 'client'
  }

  if (lowerName.includes('web') || lowerName.includes('mobile') || lowerName.includes('ios') || lowerName.includes('android')) {
    return 'client'
  }

  return 'service'
}

function loadFlowConfig(cwd: string): {config: FlowConfig; path?: string} {
  const candidates = [
    path.join(cwd, '.sdx', 'flow.config.json'),
    path.join(cwd, '.sdx', 'flow.config.yaml'),
    path.join(cwd, '.sdx', 'flow.config.yml'),
  ]

  for (const candidate of candidates) {
    if (!fileExists(candidate)) {
      continue
    }

    const text = safeReadText(candidate)
    const parsed = candidate.endsWith('.json') ? JSON.parse(text) : YAML.parse(text)
    const config = FLOW_CONFIG_SCHEMA.parse(parsed)
    return {
      config,
      path: candidate,
    }
  }

  return {config: {}}
}

function defaultFlowOverrides(mapId: string): FlowOverrides {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    aliases: {},
    serviceOwnership: {},
    assertedEdges: [],
    suppressedEdges: [],
  }
}

function loadFlowOverrides(mapId: string, cwd: string): {overrides: FlowOverrides; path: string} {
  const filePath = path.join(getMapDir(mapId, cwd), 'flow-overrides.json')
  if (!fileExists(filePath)) {
    return {
      overrides: defaultFlowOverrides(mapId),
      path: filePath,
    }
  }

  const parsed = FLOW_OVERRIDES_SCHEMA.parse(readJsonFile<unknown>(filePath))
  return {
    path: filePath,
    overrides: {
      schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
      generatedAt: parsed.generatedAt ?? new Date().toISOString(),
      mapId: parsed.mapId ?? mapId,
      aliases: parsed.aliases ?? {},
      serviceOwnership: parsed.serviceOwnership ?? {},
      assertedEdges: parsed.assertedEdges ?? [],
      suppressedEdges: parsed.suppressedEdges ?? [],
    },
  }
}

function shouldIgnoreEndpoint(endpoint: string, config: FlowConfig): boolean {
  const normalized = endpoint.trim().toLowerCase()
  if (normalized.length === 0) {
    return true
  }

  const explicitIgnore = new Set((config.ignoreEndpoints ?? []).map((value) => value.trim().toLowerCase()))
  if (explicitIgnore.has(normalized)) {
    return true
  }

  const includePatterns = (config.endpointPatterns?.include ?? []).map((pattern) => new RegExp(pattern, 'i'))
  const excludePatterns = (config.endpointPatterns?.exclude ?? []).map((pattern) => new RegExp(pattern, 'i'))

  if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(endpoint))) {
    return true
  }

  if (excludePatterns.some((pattern) => pattern.test(endpoint))) {
    return true
  }

  return false
}

function parseOpenApiOperations(contract: ContractRecord, repo: RepoRecord): ContractOperation[] {
  if (!repo.localPath) {
    return []
  }

  const absolutePath = path.join(repo.localPath, contract.path)
  if (!fileExists(absolutePath)) {
    return []
  }

  try {
    const content = safeReadText(absolutePath)
    const payload = absolutePath.endsWith('.json') ? JSON.parse(content) : YAML.parse(content)
    const paths = payload?.paths as Record<string, Record<string, unknown>> | undefined
    if (!paths || typeof paths !== 'object') {
      return []
    }

    const operations: ContractOperation[] = []
    for (const [endpointPath, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== 'object') {
        continue
      }

      for (const [method, operation] of Object.entries(methods)) {
        if (!METHOD_NAMES.includes(method.toUpperCase() as (typeof METHOD_NAMES)[number])) {
          continue
        }

        const opId = typeof (operation as {operationId?: unknown}).operationId === 'string'
          ? String((operation as {operationId?: string}).operationId)
          : `${method.toUpperCase()} ${endpointPath}`

        operations.push({
          service: contract.repo,
          method: method.toUpperCase(),
          path: normalizePathForMatch(endpointPath),
          schemaRef: `${contract.sourcePointer}#${opId}`,
        })
      }
    }

    return operations
  } catch {
    return []
  }
}

function parseAsyncChannels(contract: ContractRecord, repo: RepoRecord): ContractChannel[] {
  if (!repo.localPath) {
    return []
  }

  const absolutePath = path.join(repo.localPath, contract.path)
  if (!fileExists(absolutePath)) {
    return []
  }

  try {
    const content = safeReadText(absolutePath)
    const payload = absolutePath.endsWith('.json') ? JSON.parse(content) : YAML.parse(content)
    const channels = payload?.channels as Record<string, unknown> | undefined
    if (!channels || typeof channels !== 'object') {
      return []
    }

    return Object.keys(channels)
      .sort((a, b) => a.localeCompare(b))
      .map((channel) => ({
        service: contract.repo,
        channel,
        schemaRef: `${contract.sourcePointer}#channel:${channel}`,
      }))
  } catch {
    return []
  }
}

function parseGraphQlOperations(contract: ContractRecord, repo: RepoRecord): ContractOperation[] {
  if (!repo.localPath) {
    return []
  }

  const absolutePath = path.join(repo.localPath, contract.path)
  if (!fileExists(absolutePath)) {
    return []
  }

  const content = safeReadText(absolutePath)
  const operations: ContractOperation[] = []

  const typePattern = /type\s+(Query|Mutation)\s*{([\s\S]*?)}/g
  let match: RegExpExecArray | null
  while ((match = typePattern.exec(content)) !== null) {
    const body = match[2]
    const fieldPattern = /^\s*([A-Za-z0-9_]+)\s*\(/gm
    let fieldMatch: RegExpExecArray | null
    while ((fieldMatch = fieldPattern.exec(body)) !== null) {
      const operationName = fieldMatch[1]
      operations.push({
        service: contract.repo,
        method: 'POST',
        path: '/graphql',
        schemaRef: `${contract.sourcePointer}#${match[1].toLowerCase()}:${operationName}`,
      })
    }
  }

  if (operations.length === 0 && content.trim().length > 0) {
    operations.push({
      service: contract.repo,
      method: 'POST',
      path: '/graphql',
      schemaRef: `${contract.sourcePointer}#graphql`,
    })
  }

  return operations
}

function parseProtoOperations(contract: ContractRecord, repo: RepoRecord): ContractOperation[] {
  if (!repo.localPath) {
    return []
  }

  const absolutePath = path.join(repo.localPath, contract.path)
  if (!fileExists(absolutePath)) {
    return []
  }

  const content = safeReadText(absolutePath)
  const operations: ContractOperation[] = []
  const servicePattern = /service\s+([A-Za-z0-9_]+)\s*{([\s\S]*?)}/g
  let match: RegExpExecArray | null
  while ((match = servicePattern.exec(content)) !== null) {
    const serviceName = match[1]
    const body = match[2]
    const rpcPattern = /rpc\s+([A-Za-z0-9_]+)\s*\(/g
    let rpcMatch: RegExpExecArray | null
    while ((rpcMatch = rpcPattern.exec(body)) !== null) {
      const rpcName = rpcMatch[1]
      operations.push({
        service: contract.repo,
        method: 'POST',
        path: normalizePathForMatch(`/grpc/${serviceName}/${rpcName}`),
        schemaRef: `${contract.sourcePointer}#rpc:${serviceName}.${rpcName}`,
      })
    }
  }

  return operations
}

function parseMarkdownContractSignals(contract: ContractRecord, repo: RepoRecord): {
  operations: ContractOperation[]
  channels: ContractChannel[]
} {
  if (!repo.localPath) {
    return {operations: [], channels: []}
  }

  const absolutePath = path.join(repo.localPath, contract.path)
  if (!fileExists(absolutePath)) {
    return {operations: [], channels: []}
  }

  const content = safeReadText(absolutePath)
  const operations: ContractOperation[] = []
  const channels: ContractChannel[] = []

  const endpointPattern = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/[A-Za-z0-9_./:{}-]*)/g
  let endpointMatch: RegExpExecArray | null
  while ((endpointMatch = endpointPattern.exec(content)) !== null) {
    const method = endpointMatch[1].toUpperCase()
    const endpointPath = normalizePathForMatch(endpointMatch[2])
    operations.push({
      service: contract.repo,
      method,
      path: endpointPath,
      schemaRef: `${contract.sourcePointer}#${method}:${endpointPath}`,
    })
  }

  const channelPattern = /\b(channel|topic|event)\s*[:=]\s*([A-Za-z0-9_.-]+)/gi
  let channelMatch: RegExpExecArray | null
  while ((channelMatch = channelPattern.exec(content)) !== null) {
    channels.push({
      service: contract.repo,
      channel: channelMatch[2],
      schemaRef: `${contract.sourcePointer}#channel:${channelMatch[2]}`,
    })
  }

  return {operations, channels}
}

function collectContractSignals(contracts: ContractRecord[], repoMap: Map<string, RepoRecord>): {
  operations: ContractOperation[]
  channels: ContractChannel[]
} {
  const operations: ContractOperation[] = []
  const channels: ContractChannel[] = []

  for (const contract of contracts) {
    const repo = repoMap.get(contract.repo)
    if (!repo) {
      continue
    }

    if (contract.type === 'openapi') {
      operations.push(...parseOpenApiOperations(contract, repo))
      continue
    }

    if (contract.type === 'asyncapi') {
      channels.push(...parseAsyncChannels(contract, repo))
      continue
    }

    if (contract.type === 'graphql') {
      operations.push(...parseGraphQlOperations(contract, repo))
      continue
    }

    if (contract.type === 'proto') {
      operations.push(...parseProtoOperations(contract, repo))
      continue
    }

    if (contract.type === 'markdown') {
      const parsed = parseMarkdownContractSignals(contract, repo)
      operations.push(...parsed.operations)
      channels.push(...parsed.channels)
    }
  }

  operations.sort((a, b) => `${a.service}|${a.method}|${a.path}`.localeCompare(`${b.service}|${b.method}|${b.path}`))
  channels.sort((a, b) => `${a.service}|${a.channel}`.localeCompare(`${b.service}|${b.channel}`))

  return {operations, channels}
}

function maybeVersionFromPath(routePath: string): string {
  const match = routePath.match(/^\/v(\d+)(\/|$)/i)
  if (!match) {
    return 'unknown'
  }

  return `v${match[1]}`
}

function authHint(content: string): string {
  const lower = content.toLowerCase()
  if (lower.includes('oauth') || lower.includes('bearer') || lower.includes('authorization')) {
    return 'required'
  }

  if (lower.includes('public') || lower.includes('unauthenticated')) {
    return 'none'
  }

  return 'unknown'
}

function extractEndpointsFromContent(service: string, relativePath: string, content: string, config: FlowConfig): EndpointInventoryRecord[] {
  const out: EndpointInventoryRecord[] = []
  const endpointMap = new Map<string, EndpointInventoryRecord>()
  const hintsAuth = authHint(content)

  const expressPatterns: Array<{regex: RegExp; methodIndex: number; pathIndex: number}> = [
    {regex: /\b(?:app|router)\.(get|post|put|patch|delete|options|head)\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2},
    {regex: /\bfastify\.(get|post|put|patch|delete|options|head)\(\s*['"`]([^'"`]+)['"`]/g, methodIndex: 1, pathIndex: 2},
    {regex: /@(?:Get|Post|Put|Patch|Delete|Options|Head)\(\s*['"`]?([^'"`)]+)?/g, methodIndex: 0, pathIndex: 1},
    {regex: /\.route\(\s*['"`]([^'"`]+)['"`]\s*,\s*(get|post|put|patch|delete|options|head)/g, methodIndex: 2, pathIndex: 1},
    {regex: /\b(?:GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/g, methodIndex: 0, pathIndex: 1},
  ]

  for (const pattern of expressPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.regex.exec(content)) !== null) {
      const method = pattern.methodIndex === 0
        ? (match[0].match(/@(Get|Post|Put|Patch|Delete|Options|Head)/)?.[1] ?? match[0].match(/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/)?.[1] ?? 'GET').toUpperCase()
        : String(match[pattern.methodIndex] ?? 'GET').toUpperCase()
      const routePath = normalizePathForMatch(String(match[pattern.pathIndex] ?? '/'))
      const endpointSignature = `${method} ${routePath}`
      if (shouldIgnoreEndpoint(endpointSignature, config)) {
        continue
      }

      const candidate: EndpointInventoryRecord = {
        id: endpointIdFor(service, method, routePath),
        service,
        method,
        path: routePath,
        auth: hintsAuth,
        version: maybeVersionFromPath(routePath),
        sourceFile: relativePath,
        sourceLine: lineFromIndex(content, match.index),
      }
      endpointMap.set(candidate.id, candidate)
    }
  }

  // Next.js app router route handlers
  if (/\/(app|src\/app)\/api\/.+\/route\.(ts|tsx|js|jsx)$/i.test(relativePath)) {
    const routePart = relativePath
      .replace(/^[^]*?(?:app|src\/app)\/api\//, '')
      .replace(/\/route\.(ts|tsx|js|jsx)$/i, '')
      .replace(/\[(.*?)\]/g, '{$1}')
    const routePath = normalizePathForMatch(`/api/${routePart}`)

    const handlerPattern = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/g
    let match: RegExpExecArray | null
    while ((match = handlerPattern.exec(content)) !== null) {
      const method = String(match[1]).toUpperCase()
      const endpointSignature = `${method} ${routePath}`
      if (shouldIgnoreEndpoint(endpointSignature, config)) {
        continue
      }

      const candidate: EndpointInventoryRecord = {
        id: endpointIdFor(service, method, routePath),
        service,
        method,
        path: routePath,
        auth: hintsAuth,
        version: maybeVersionFromPath(routePath),
        sourceFile: relativePath,
        sourceLine: lineFromIndex(content, match.index),
      }
      endpointMap.set(candidate.id, candidate)
    }
  }

  out.push(...[...endpointMap.values()].sort((a, b) => `${a.method}|${a.path}`.localeCompare(`${b.method}|${b.path}`)))
  return out
}

function parseTimeoutMs(fragment: string): number | undefined {
  const direct = fragment.match(/timeout\s*[:=]\s*(\d{2,7})/i)
  if (direct) {
    return Number(direct[1])
  }

  return undefined
}

function parseRetryPolicy(fragment: string): string | undefined {
  if (/retry/i.test(fragment)) {
    return 'configured'
  }

  return undefined
}

function extractCallSitesFromContent(
  service: string,
  repoKind: 'client' | 'service',
  relativePath: string,
  content: string,
): RawCallSite[] {
  const out: RawCallSite[] = []

  const fetchPattern = /fetch\(\s*([^,\)]+)(?:,\s*({[\s\S]{0,400}?}))?\)/g
  let match: RegExpExecArray | null
  while ((match = fetchPattern.exec(content)) !== null) {
    const rawTarget = quoteTrim(match[1])
    const options = match[2] ?? ''
    const method = (options.match(/method\s*:\s*['"`]?(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)/i)?.[1] ?? 'GET').toUpperCase()
    out.push({
      callerService: service,
      callerKind: repoKind,
      method,
      targetRaw: rawTarget,
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
      protocol: rawTarget.startsWith('grpc://') ? 'grpc' : 'http',
      timeoutMs: parseTimeoutMs(options),
      retryPolicy: parseRetryPolicy(options),
    })
  }

  const axiosPattern = /axios\.(get|post|put|patch|delete|options|head)\(\s*([^,\)]+)/g
  while ((match = axiosPattern.exec(content)) !== null) {
    const method = String(match[1]).toUpperCase()
    const rawTarget = quoteTrim(match[2])
    out.push({
      callerService: service,
      callerKind: repoKind,
      method,
      targetRaw: rawTarget,
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
      protocol: rawTarget.startsWith('grpc://') ? 'grpc' : 'http',
    })
  }

  const axiosObjectPattern = /axios\(\s*{[\s\S]{0,500}?}\s*\)/g
  while ((match = axiosObjectPattern.exec(content)) !== null) {
    const fragment = match[0]
    const method = (fragment.match(/method\s*:\s*['"`]?(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)/i)?.[1] ?? 'GET').toUpperCase()
    const url = quoteTrim(fragment.match(/url\s*:\s*([^,\n}]+)/i)?.[1] ?? '')
    if (url.length === 0) {
      continue
    }

    out.push({
      callerService: service,
      callerKind: repoKind,
      method,
      targetRaw: url,
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
      protocol: url.startsWith('grpc://') ? 'grpc' : 'http',
      timeoutMs: parseTimeoutMs(fragment),
      retryPolicy: parseRetryPolicy(fragment),
    })
  }

  const graphqlClientPattern = /new\s+GraphQLClient\(\s*([^,\)]+)/g
  while ((match = graphqlClientPattern.exec(content)) !== null) {
    const rawTarget = quoteTrim(match[1])
    out.push({
      callerService: service,
      callerKind: repoKind,
      method: 'POST',
      targetRaw: rawTarget,
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
      protocol: 'http',
    })
  }

  const urlSessionPattern = /URLSession\.(?:shared\.)?dataTask\(with:\s*URL\(string:\s*([^)]+)\)/g
  while ((match = urlSessionPattern.exec(content)) !== null) {
    const rawTarget = quoteTrim(match[1])
    out.push({
      callerService: service,
      callerKind: repoKind,
      method: 'GET',
      targetRaw: rawTarget,
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
      protocol: rawTarget.startsWith('grpc://') ? 'grpc' : 'http',
    })
  }

  return out
}

function extractEventSignalsFromContent(service: string, relativePath: string, content: string): RawEventSignal[] {
  const out: RawEventSignal[] = []
  const publishPattern = /(?:publish|emit|produce|enqueue|send)\w*\(\s*['"`]([^'"`]{2,160})['"`]/gi
  let match: RegExpExecArray | null
  while ((match = publishPattern.exec(content)) !== null) {
    out.push({
      service,
      direction: 'publish',
      topic: sanitizeLabel(match[1]),
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
    })
  }

  const consumePattern = /(?:consume|subscribe|on|listen)\w*\(\s*['"`]([^'"`]{2,160})['"`]/gi
  while ((match = consumePattern.exec(content)) !== null) {
    out.push({
      service,
      direction: 'consume',
      topic: sanitizeLabel(match[1]),
      sourceFile: relativePath,
      sourceLine: lineFromIndex(content, match.index),
    })
  }

  return out
}

function extractStoreSignalsFromContent(service: string, relativePath: string, content: string): RawStoreSignal[] {
  const lower = content.toLowerCase()
  const out: RawStoreSignal[] = []

  for (const keyword of DATASTORE_KEYWORDS) {
    if (!lower.includes(keyword)) {
      continue
    }

    const readType: RawStoreSignal['type'] = /select|find\(|query\(/i.test(content) ? 'db_read' : 'db_write'
    out.push({
      service,
      store: keyword,
      type: readType,
      sourceFile: relativePath,
      sourceLine: 1,
    })
  }

  for (const keyword of CACHE_KEYWORDS) {
    if (!lower.includes(keyword)) {
      continue
    }

    const cacheType: RawStoreSignal['type'] = /get\(|mget\(|read/i.test(content) ? 'cache_read' : 'cache_write'
    out.push({
      service,
      store: keyword,
      type: cacheType,
      sourceFile: relativePath,
      sourceLine: 1,
    })
  }

  return out
}

function serviceAliasMap(config: FlowConfig, overrides: FlowOverrides, repos: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const repo of repos) {
    map.set(repo.toLowerCase(), repo)
    map.set(`${repo}.internal`.toLowerCase(), repo)
    map.set(`${repo}.svc.cluster.local`.toLowerCase(), repo)
  }

  for (const [alias, repo] of Object.entries(config.serviceAliases ?? {})) {
    map.set(alias.toLowerCase(), repo)
  }

  for (const [alias, repo] of Object.entries(overrides.aliases ?? {})) {
    map.set(alias.toLowerCase(), repo)
  }

  return map
}

function externalAliasMap(config: FlowConfig): Map<string, string> {
  const out = new Map<string, string>()
  for (const [alias, label] of Object.entries(config.externalDependencyAliases ?? {})) {
    out.set(alias.toLowerCase(), label)
  }
  return out
}

function resolveServiceByHost(host: string, aliases: Map<string, string>, repos: string[]): string | undefined {
  const normalized = host.toLowerCase().replace(/:\d+$/, '')
  const direct = aliases.get(normalized)
  if (direct) {
    return direct
  }

  const stripped = normalized.split('.').filter((part) => part.length > 0)
  for (const repo of repos) {
    const lowerRepo = repo.toLowerCase()
    if (normalized === lowerRepo || normalized.startsWith(`${lowerRepo}.`) || stripped.includes(lowerRepo)) {
      return repo
    }
  }

  return undefined
}

function resolveExternalByHost(host: string, externalAliases: Map<string, string>): string | undefined {
  const normalized = host.toLowerCase().replace(/:\d+$/, '')
  const direct = externalAliases.get(normalized)
  if (direct) {
    return direct
  }

  const segments = normalized.split('.').filter((segment) => segment.length > 0)
  for (let i = 0; i < segments.length; i += 1) {
    const candidate = segments.slice(i).join('.')
    const mapped = externalAliases.get(candidate)
    if (mapped) {
      return mapped
    }
  }

  return undefined
}

function shouldScanSourceFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()
  if (!SOURCE_EXTENSIONS.test(lower)) {
    return false
  }

  const blockedFragments = ['/node_modules/', '/dist/', '/build/', '/coverage/', '/.next/', '/vendor/', '/__tests__/']
  if (blockedFragments.some((fragment) => lower.includes(fragment))) {
    return false
  }

  if (/\/(test|tests|spec)\//i.test(lower)) {
    return false
  }

  if (/\.(test|spec)\.[a-z0-9]+$/i.test(lower)) {
    return false
  }

  if (/\.d\.ts$/i.test(lower)) {
    return false
  }

  return true
}

function stripLikelyComments(relativePath: string, content: string): string {
  const lower = relativePath.toLowerCase()
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|go|rs|java|kt|swift|dart|py)$/i.test(lower)) {
    return content
  }

  let stripped = content.replace(/\/\*[\s\S]*?\*\//g, ' ')
  stripped = stripped
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/g, '').replace(/^\s*#.*$/g, ''))
    .join('\n')

  return stripped
}

function extractEnvVarToken(value: string): string | undefined {
  const patterns = [
    /process\.env\.([A-Z0-9_]+)/,
    /import\.meta\.env\.([A-Z0-9_]+)/,
    /\$\{([A-Z0-9_]+)\}/,
  ]

  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) {
      return match[1]
    }
  }

  return undefined
}

function maybeUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function ensureNode(nodes: Map<string, FlowNode>, node: FlowNode): void {
  const existing = nodes.get(node.id)
  if (!existing) {
    nodes.set(node.id, node)
    return
  }

  nodes.set(node.id, {
    ...existing,
    ...node,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(node.metadata ?? {}),
    },
  })
}

function edgeKey(edge: {
  type: FlowEdgeType
  from: string
  to: string
  protocol: string
  payloadSchemaRef?: string
}): string {
  return `${edge.type}|${edge.from}|${edge.to}|${edge.protocol}|${edge.payloadSchemaRef ?? ''}`
}

function addEvidence(set: Set<string>, value: string): void {
  if (value.trim().length > 0) {
    set.add(value)
  }
}

function upsertEdge(
  accumulators: Map<string, EdgeAccumulator>,
  candidate: {
    type: FlowEdgeType
    from: string
    to: string
    protocol?: string
    auth?: string
    payloadSchemaRef?: string
    piiTags?: string[]
    evidenceRef: string
    source: 'static' | 'runtime' | 'override'
    env?: FlowEnvironment
    seenAt?: string
  },
): void {
  const key = edgeKey({
    type: candidate.type,
    from: candidate.from,
    to: candidate.to,
    protocol: candidate.protocol ?? 'unknown',
    payloadSchemaRef: candidate.payloadSchemaRef,
  })

  const existing = accumulators.get(key)
  if (!existing) {
    const created: EdgeAccumulator = {
      type: candidate.type,
      from: candidate.from,
      to: candidate.to,
      protocol: candidate.protocol ?? 'unknown',
      auth: candidate.auth ?? 'unknown',
      payloadSchemaRef: candidate.payloadSchemaRef,
      piiTags: new Set(candidate.piiTags ?? []),
      evidenceRefs: new Set([candidate.evidenceRef]),
      lastSeenByEnv: candidate.env && candidate.seenAt ? {[candidate.env]: candidate.seenAt} : {},
      hasStatic: candidate.source === 'static',
      hasRuntime: candidate.source === 'runtime',
      hasOverride: candidate.source === 'override',
      runtimeByEnv: candidate.env ? new Set([candidate.env]) : new Set(),
    }
    accumulators.set(key, created)
    return
  }

  addEvidence(existing.evidenceRefs, candidate.evidenceRef)
  for (const tag of candidate.piiTags ?? []) {
    existing.piiTags.add(tag)
  }

  if (candidate.auth && existing.auth === 'unknown') {
    existing.auth = candidate.auth
  }

  if (!existing.payloadSchemaRef && candidate.payloadSchemaRef) {
    existing.payloadSchemaRef = candidate.payloadSchemaRef
  }

  if (candidate.env) {
    existing.runtimeByEnv.add(candidate.env)
  }

  if (candidate.env && candidate.seenAt) {
    const prior = existing.lastSeenByEnv[candidate.env]
    if (!prior || new Date(candidate.seenAt).getTime() > new Date(prior).getTime()) {
      existing.lastSeenByEnv[candidate.env] = candidate.seenAt
    }
  }

  existing.hasStatic ||= candidate.source === 'static'
  existing.hasRuntime ||= candidate.source === 'runtime'
  existing.hasOverride ||= candidate.source === 'override'
}

function confidenceForEdge(edge: EdgeAccumulator): number {
  let score = 0.22
  if (edge.hasStatic) {
    score += 0.32
  }
  if (edge.hasRuntime) {
    score += 0.14
  }
  if (edge.runtimeByEnv.has('dev')) {
    score += 0.06
  }
  if (edge.runtimeByEnv.has('staging')) {
    score += 0.09
  }
  if (edge.runtimeByEnv.has('prod')) {
    score += 0.18
  }
  if (edge.payloadSchemaRef) {
    score += 0.1
  }
  if (edge.hasOverride) {
    score += 0.18
  }

  if (edge.type === 'grpc_call' || edge.type === 'http_call') {
    score += 0.03
  }

  if (score > 0.99) {
    return 0.99
  }

  return Number(score.toFixed(3))
}

function sourceForEdge(edge: EdgeAccumulator): FlowEdge['source'] {
  if (edge.hasOverride) {
    return 'override'
  }

  if (edge.hasRuntime) {
    return 'runtime'
  }

  return 'static'
}

function piiTagsFromPath(endpointPath: string): string[] {
  const lower = endpointPath.toLowerCase()
  const tags: string[] = []
  if (lower.includes('user') || lower.includes('account') || lower.includes('profile')) {
    tags.push('user_data')
  }
  if (lower.includes('payment') || lower.includes('card') || lower.includes('billing')) {
    tags.push('financial')
  }
  if (lower.includes('email') || lower.includes('phone')) {
    tags.push('contact')
  }

  return tags
}

function parseAttributeValue(input: unknown): string | undefined {
  if (typeof input === 'string') {
    return input
  }

  if (typeof input === 'number' || typeof input === 'bigint' || typeof input === 'boolean') {
    return String(input)
  }

  if (!input || typeof input !== 'object') {
    return undefined
  }

  const candidate = input as Record<string, unknown>
  const keys = ['stringValue', 'intValue', 'doubleValue', 'boolValue']
  for (const key of keys) {
    if (candidate[key] !== undefined) {
      return parseAttributeValue(candidate[key])
    }
  }

  if (candidate['arrayValue']) {
    const values = (candidate['arrayValue'] as {values?: unknown[]}).values ?? []
    return values.map((value) => parseAttributeValue(value)).filter((value): value is string => Boolean(value)).join(',')
  }

  return undefined
}

function attributesFromAny(input: unknown): Record<string, string> {
  if (!input) {
    return {}
  }

  if (Array.isArray(input)) {
    const out: Record<string, string> = {}
    for (const item of input) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const key = String((item as {key?: string}).key ?? '').trim()
      if (!key) {
        continue
      }

      const value = parseAttributeValue((item as {value?: unknown}).value)
      if (value !== undefined) {
        out[key] = value
      }
    }

    return out
  }

  if (typeof input === 'object') {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const parsed = parseAttributeValue(value)
      if (parsed !== undefined) {
        out[key] = parsed
      }
    }

    return out
  }

  return {}
}

function normalizeTimestamp(input: unknown): string | undefined {
  if (typeof input !== 'string' && typeof input !== 'number') {
    return undefined
  }

  const asString = String(input)
  if (/^\d{10,}$/.test(asString)) {
    const numeric = Number(asString)
    if (!Number.isNaN(numeric)) {
      if (asString.length > 13) {
        return new Date(Math.floor(numeric / 1_000_000)).toISOString()
      }

      return new Date(numeric).toISOString()
    }
  }

  const parsed = new Date(asString)
  if (Number.isNaN(parsed.getTime())) {
    return undefined
  }

  return parsed.toISOString()
}

function parseRuntimeRecordFromSpanLike(spanLike: Record<string, unknown>, env: FlowEnvironment, evidenceRef: string): RuntimeRecord {
  const attr = {
    ...attributesFromAny(spanLike.attributes),
    ...attributesFromAny(spanLike.resourceAttributes),
  }

  const serviceName = attr['service.name'] ?? attr['service']
  const method = attr['http.method'] ?? attr['rpc.method']
  const route = attr['http.route'] ?? attr['url.path'] ?? attr['http.target']
  const url = attr['http.url'] ?? attr['url.full'] ?? attr['net.peer.url']
  const protocol = attr['network.protocol.name'] ?? attr['rpc.system']
  const peerService = attr['peer.service'] ?? attr['http.host'] ?? attr['net.peer.name']
  const messagingDestination = attr['messaging.destination'] ?? attr['message.bus.destination']
  const dbSystem = attr['db.system']
  const dbOperation = attr['db.operation']

  return {
    env,
    serviceName,
    method,
    path: route,
    url,
    protocol,
    peerService,
    messagingDestination,
    dbSystem,
    dbOperation,
    timestamp: normalizeTimestamp(
      spanLike.endTimeUnixNano ??
        spanLike.endTime ??
        spanLike.timestamp ??
        attr.endTime ??
        attr.end_time ??
        attr.timestamp,
    ),
    evidenceRef,
  }
}

function parseRuntimeRecordsFromPayload(payload: unknown, env: FlowEnvironment, evidencePrefix: string): RuntimeRecord[] {
  const records: RuntimeRecord[] = []

  function walk(value: unknown, prefix: string): void {
    if (!value) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach((item, idx) => walk(item, `${prefix}:${idx}`))
      return
    }

    if (typeof value !== 'object') {
      return
    }

    const obj = value as Record<string, unknown>

    if (Array.isArray(obj.resourceSpans)) {
      obj.resourceSpans.forEach((resourceSpan, resourceIndex) => {
        if (!resourceSpan || typeof resourceSpan !== 'object') {
          return
        }

        const rs = resourceSpan as Record<string, unknown>
        const resourceAttributes = attributesFromAny((rs.resource as {attributes?: unknown})?.attributes)
        const containers = [
          ...(Array.isArray(rs.scopeSpans) ? rs.scopeSpans : []),
          ...(Array.isArray(rs.instrumentationLibrarySpans) ? rs.instrumentationLibrarySpans : []),
        ]

        containers.forEach((container, containerIndex) => {
          if (!container || typeof container !== 'object') {
            return
          }

          const spans = Array.isArray((container as {spans?: unknown[]}).spans) ? (container as {spans?: unknown[]}).spans! : []
          spans.forEach((span, spanIndex) => {
            if (!span || typeof span !== 'object') {
              return
            }

            const merged = {
              ...span,
              resourceAttributes,
            }
            records.push(
              parseRuntimeRecordFromSpanLike(
                merged as Record<string, unknown>,
                env,
                `${evidencePrefix}:resource${resourceIndex}:container${containerIndex}:span${spanIndex}`,
              ),
            )
          })
        })
      })
      return
    }

    if (Array.isArray(obj.spans)) {
      obj.spans.forEach((span, idx) => {
        if (!span || typeof span !== 'object') {
          return
        }

        records.push(parseRuntimeRecordFromSpanLike(span as Record<string, unknown>, env, `${prefix}:span${idx}`))
      })
      return
    }

    if (obj.attributes || obj['service.name'] || obj['http.method'] || obj['messaging.destination']) {
      records.push(parseRuntimeRecordFromSpanLike(obj, env, prefix))
      return
    }

    for (const [key, nested] of Object.entries(obj)) {
      walk(nested, `${prefix}:${key}`)
    }
  }

  walk(payload, evidencePrefix)
  return records
}

function parseRuntimeRecordsFromFile(filePath: string, env: FlowEnvironment, cwd: string): RuntimeRecord[] {
  const text = safeReadText(filePath).trim()
  if (!text) {
    return []
  }

  const evidencePrefix = `runtime:${env}:${toRelative(filePath, cwd)}`
  const records: RuntimeRecord[] = []

  const tryJsonPayload = (): unknown | undefined => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  const parsedJson = tryJsonPayload()
  if (parsedJson !== undefined) {
    return parseRuntimeRecordsFromPayload(parsedJson, env, evidencePrefix)
  }

  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      return
    }

    try {
      const payload = JSON.parse(trimmed)
      records.push(...parseRuntimeRecordsFromPayload(payload, env, `${evidencePrefix}:line${index + 1}`))
    } catch {
      // Ignore non-JSON line entries.
    }
  })

  return records
}

function runtimeDirByEnv(cwd: string, mapId: string, config: FlowConfig, overrideRuntimeDir?: string): Record<FlowEnvironment, string> {
  const defaultBase = overrideRuntimeDir
    ? path.resolve(cwd, overrideRuntimeDir)
    : path.join(cwd, 'runtime', 'otel', mapId)

  const configPaths = config.runtime?.pathsByEnv ?? {}
  return {
    dev: path.resolve(cwd, configPaths.dev ?? path.join(defaultBase, 'dev')),
    staging: path.resolve(cwd, configPaths.staging ?? path.join(defaultBase, 'staging')),
    prod: path.resolve(cwd, configPaths.prod ?? path.join(defaultBase, 'prod')),
  }
}

function collectRuntimeRecords(
  cwd: string,
  mapId: string,
  config: FlowConfig,
  runtimeDir: string | undefined,
  envFilter: FlowEnvironment | 'all',
): RuntimeRecord[] {
  const byEnv = runtimeDirByEnv(cwd, mapId, config, runtimeDir)
  const envs: FlowEnvironment[] = envFilter === 'all' ? ['dev', 'staging', 'prod'] : [envFilter]
  const out: RuntimeRecord[] = []

  for (const env of envs) {
    const dirPath = byEnv[env]
    if (!fileExists(dirPath)) {
      continue
    }

    const files = listFilesRecursive(dirPath)
      .filter((candidate) => /\.(json|jsonl|ndjson)$/i.test(candidate))
      .sort((a, b) => a.localeCompare(b))

    for (const filePath of files) {
      out.push(...parseRuntimeRecordsFromFile(filePath, env, cwd))
    }
  }

  return out
}

function parseTargetAsUrl(rawTarget: string, repoEnv: Record<string, string>): string {
  const envToken = extractEnvVarToken(rawTarget)
  if (envToken && repoEnv[envToken]) {
    const resolved = repoEnv[envToken]
    if (/^https?:\/\//i.test(resolved) || /^grpc:\/\//i.test(resolved)) {
      return resolved
    }
  }

  return rawTarget
}

function resolveCallTarget(args: {
  call: RawCallSite
  repoEnv: Record<string, string>
  endpointByMethodPath: Map<string, EndpointInventoryRecord[]>
  aliases: Map<string, string>
  externalAliases: Map<string, string>
  repos: string[]
}): {
  targetService?: string
  targetExternal?: string
  endpoint?: EndpointInventoryRecord
  unresolvedReason?: string
  normalizedPath?: string
  resolvedUrl?: string
} {
  const resolvedRaw = parseTargetAsUrl(args.call.targetRaw, args.repoEnv)
  const envToken = extractEnvVarToken(args.call.targetRaw)

  const parsedUrl = maybeUrl(resolvedRaw.replace(/^grpc:\/\//i, 'http://'))
  if (parsedUrl) {
    const targetService = resolveServiceByHost(parsedUrl.host, args.aliases, args.repos)
    const targetExternal = targetService ? undefined : resolveExternalByHost(parsedUrl.host, args.externalAliases)
    const normalizedPath = normalizePathForMatch(parsedUrl.pathname)
    const methodPathKey = `${args.call.method.toUpperCase()}|${normalizedPath}`
    const candidates = args.endpointByMethodPath.get(methodPathKey) ?? []
    const endpoint = targetService
      ? candidates.find((candidate) => candidate.service === targetService) ?? (candidates.length === 1 ? candidates[0] : undefined)
      : undefined

    return {
      targetService,
      targetExternal,
      endpoint,
      normalizedPath,
      resolvedUrl: parsedUrl.toString(),
      unresolvedReason: !targetService && !targetExternal ? 'unknown_target_service' : undefined,
    }
  }

  if (resolvedRaw.startsWith('/')) {
    const normalizedPath = normalizePathForMatch(resolvedRaw)
    const methodPathKey = `${args.call.method.toUpperCase()}|${normalizedPath}`
    const candidates = args.endpointByMethodPath.get(methodPathKey) ?? []

    if (candidates.length === 1) {
      return {
        targetService: candidates[0].service,
        endpoint: candidates[0],
        normalizedPath,
      }
    }

    if (candidates.length > 1) {
      return {
        unresolvedReason: 'ambiguous_endpoint_owner',
        normalizedPath,
      }
    }

    return {
      unresolvedReason: 'unresolved_relative_path',
      normalizedPath,
    }
  }

  if (envToken) {
    return {
      unresolvedReason: `unresolved_env_base_url:${envToken}`,
    }
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(resolvedRaw)) {
    const alias = args.aliases.get(resolvedRaw.toLowerCase())
    if (alias) {
      return {
        targetService: alias,
      }
    }
  }

  const externalAlias = args.externalAliases.get(resolvedRaw.toLowerCase())
  if (externalAlias) {
    return {
      targetExternal: externalAlias,
    }
  }

  return {
    unresolvedReason: 'unresolved_target',
  }
}

function dedupeFindings(findings: FlowFinding[], ignoredCodes: Set<string>): FlowFinding[] {
  const byKey = new Map<string, FlowFinding>()
  for (const finding of findings) {
    if (ignoredCodes.has(finding.code)) {
      continue
    }

    const key = `${finding.code}|${finding.message}|${finding.edgeId ?? ''}|${finding.service ?? ''}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, finding)
      continue
    }

    const mergedEvidence = [...new Set([...existing.evidenceRefs, ...finding.evidenceRefs])]
    byKey.set(key, {
      ...existing,
      evidenceRefs: mergedEvidence,
      confidence: Math.max(existing.confidence ?? 0, finding.confidence ?? 0),
    })
  }

  return [...byKey.values()].sort((a, b) => `${a.code}|${a.message}`.localeCompare(`${b.code}|${b.message}`))
}

function normalizeNodeRef(ref: string, nodes: Set<string>): string | undefined {
  if (nodes.has(ref)) {
    return ref
  }

  const candidates = [
    `service:${ref}`,
    `client:${ref}`,
    `endpoint:${ref}`,
    `event_bus:${ref}`,
    `datastore:${ref}`,
    `external:${ref}`,
  ]

  for (const candidate of candidates) {
    if (nodes.has(candidate)) {
      return candidate
    }
  }

  return undefined
}

function applyFlowOverrides(
  accumulators: Map<string, EdgeAccumulator>,
  overrides: FlowOverrides,
  nodeIds: Set<string>,
): void {
  const suppressed = new Set(
    overrides.suppressedEdges.map((edge) => `${edge.type}|${edge.from}|${edge.to}`),
  )

  for (const [key, edge] of accumulators.entries()) {
    const matchKey = `${edge.type}|${edge.from}|${edge.to}`
    if (suppressed.has(matchKey)) {
      accumulators.delete(key)
    }
  }

  for (const assertedEdge of overrides.assertedEdges) {
    const from = normalizeNodeRef(assertedEdge.from, nodeIds)
    const to = normalizeNodeRef(assertedEdge.to, nodeIds)
    if (!from || !to) {
      continue
    }

    upsertEdge(accumulators, {
      type: assertedEdge.type,
      from,
      to,
      protocol: assertedEdge.protocol ?? 'unknown',
      auth: assertedEdge.auth ?? 'unknown',
      evidenceRef: `override:${from}:${to}:${assertedEdge.type}`,
      source: 'override',
    })
  }
}

function buildJourneys(args: {
  graph: FlowGraphArtifact
  config: FlowConfig
}): FlowJourney[] {
  const edgeById = new Map(args.graph.edges.map((edge) => [edge.id, edge]))
  const nodeById = new Map(args.graph.nodes.map((node) => [node.id, node]))

  const journeys: FlowJourney[] = []

  for (const manual of args.config.journeys ?? []) {
    const edgeIds: string[] = []

    for (const step of manual.steps ?? []) {
      const [fromRaw, toRaw] = step.split('->').map((value) => value.trim())
      if (!fromRaw || !toRaw) {
        continue
      }

      const fromCandidates = [fromRaw, `service:${fromRaw}`, `client:${fromRaw}`, `endpoint:${fromRaw}`]
      const toCandidates = [toRaw, `service:${toRaw}`, `client:${toRaw}`, `endpoint:${toRaw}`]

      const candidate = args.graph.edges.find((edge) => fromCandidates.includes(edge.from) && toCandidates.includes(edge.to))
      if (candidate) {
        edgeIds.push(candidate.id)
      }
    }

    const confidence = edgeIds.length === 0
      ? 0
      : edgeIds.reduce((sum, edgeId) => sum + (edgeById.get(edgeId)?.confidence ?? 0), 0) / edgeIds.length

    journeys.push({
      id: `journey:${stableHash(`manual|${manual.name}`)}`,
      name: manual.name,
      source: 'manual',
      score: Number(confidence.toFixed(3)),
      edgeIds,
      notes: manual.description,
    })
  }

  const traversableEdges = args.graph.edges
    .filter((edge) => edge.type === 'http_call' || edge.type === 'grpc_call')
    .sort((a, b) => {
      const confidenceDelta = b.confidence - a.confidence
      if (confidenceDelta !== 0) {
        return confidenceDelta
      }
      return `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`)
    })

  const adjacency = new Map<string, FlowEdge[]>()
  for (const edge of traversableEdges) {
    const existing = adjacency.get(edge.from) ?? []
    existing.push(edge)
    adjacency.set(edge.from, existing)
  }

  let bestChain: FlowEdge[] = []
  let bestScore = -1
  const startNodes = args.graph.nodes
    .filter((node) => node.type === 'client' || node.type === 'service')
    .map((node) => node.id)
    .sort((a, b) => a.localeCompare(b))

  function dfs(current: string, visited: Set<string>, chain: FlowEdge[]): void {
    if (chain.length > 0) {
      const score = chain.reduce((sum, edge) => sum + edge.confidence, 0) / chain.length + chain.length * 0.05
      if (score > bestScore) {
        bestScore = score
        bestChain = [...chain]
      }
    }

    if (chain.length >= 8) {
      return
    }

    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.to)) {
        continue
      }

      visited.add(edge.to)
      chain.push(edge)
      dfs(edge.to, visited, chain)
      chain.pop()
      visited.delete(edge.to)
    }
  }

  for (const start of startNodes) {
    dfs(start, new Set([start]), [])
  }

  if (bestChain.length > 0) {
    const sourceLabel = nodeById.get(bestChain[0].from)?.label ?? bestChain[0].from
    journeys.push({
      id: `journey:${stableHash(`auto|${bestChain.map((edge) => edge.id).join('|')}`)}`,
      name: `Top request path from ${sourceLabel}`,
      source: 'auto',
      score: Number((bestScore > 0 ? bestScore : 0).toFixed(3)),
      edgeIds: bestChain.map((edge) => edge.id),
    })
  }

  return journeys
    .sort((a, b) => {
      const scoreDelta = b.score - a.score
      if (scoreDelta !== 0) {
        return scoreDelta
      }
      return a.name.localeCompare(b.name)
    })
    .map((journey, index) => ({
      ...journey,
      id: journey.id || `journey:${index + 1}`,
    }))
}

function validationFromArtifacts(args: {
  graph: FlowGraphArtifact
  findings: FlowFindingsArtifact
  config: FlowConfig
  now?: Date
}): FlowValidationResult {
  const now = args.now ?? new Date()
  const staleThreshold = args.config.runtime?.staleThresholdHours ?? 72

  const errors: string[] = []
  const warnings: string[] = []
  const prodRequiredTypes = new Set<FlowEdgeType>(['http_call', 'grpc_call', 'async_publish', 'async_consume'])

  for (const finding of args.findings.findings) {
    const confidence = finding.confidence ?? 0.5
    const isHighConfidence = confidence >= 0.7

    if (finding.code === 'missing_local_clone') {
      errors.push(finding.message)
      continue
    }

    if (finding.code === 'unresolved_base_url' && isHighConfidence) {
      errors.push(finding.message)
      continue
    }

    if (finding.code === 'unknown_endpoint_ownership' && isHighConfidence) {
      errors.push(finding.message)
      continue
    }

    if (finding.code === 'contract_mismatch' && isHighConfidence) {
      errors.push(finding.message)
      continue
    }

    warnings.push(finding.message)
  }

  for (const edge of args.graph.edges) {
    const prodSeen = edge.lastSeenByEnv.prod
    const hasAnyRuntimeEvidence = Boolean(edge.lastSeenByEnv.dev || edge.lastSeenByEnv.staging || edge.lastSeenByEnv.prod)

    if (hasAnyRuntimeEvidence && edge.confidence >= 0.7 && prodRequiredTypes.has(edge.type) && !prodSeen) {
      errors.push(
        `Missing prod runtime evidence for high-confidence edge ${edge.from} -> ${edge.to} (${edge.type}).`,
      )
    }

    if (prodSeen) {
      const elapsedMs = now.getTime() - new Date(prodSeen).getTime()
      if (elapsedMs > staleThreshold * 60 * 60 * 1000) {
        errors.push(
          `Stale runtime evidence for edge ${edge.from} -> ${edge.to} (last seen in prod ${prodSeen}, threshold ${staleThreshold}h).`,
        )
      }
    }

    if (edge.confidence < 0.45) {
      warnings.push(`Low-confidence flow edge ${edge.from} -> ${edge.to} (${edge.confidence}).`)
    }
  }

  const uniqueErrors = [...new Set(errors)].sort((a, b) => a.localeCompare(b))
  const uniqueWarnings = [...new Set(warnings)].sort((a, b) => a.localeCompare(b))

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId: args.graph.mapId,
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings: uniqueWarnings,
    stats: {
      nodeCount: args.graph.nodes.length,
      edgeCount: args.graph.edges.length,
      endpointCount: args.graph.nodes.filter((node) => node.type === 'endpoint').length,
      runtimeBackedEdges: args.graph.edges.filter((edge) => edge.source === 'runtime' || Boolean(edge.lastSeenByEnv.prod || edge.lastSeenByEnv.staging || edge.lastSeenByEnv.dev)).length,
    },
  }
}

function renderValidationMarkdown(validation: FlowValidationResult): string {
  const lines = [
    `# Flow Validation: ${validation.mapId}`,
    '',
    `- Generated: ${validation.generatedAt}`,
    `- Valid: ${validation.valid ? 'yes' : 'no'}`,
    `- Nodes: ${validation.stats.nodeCount}`,
    `- Edges: ${validation.stats.edgeCount}`,
    `- Endpoints: ${validation.stats.endpointCount}`,
    `- Runtime-backed edges: ${validation.stats.runtimeBackedEdges}`,
    '',
  ]

  if (validation.errors.length > 0) {
    lines.push('## Errors', '')
    for (const error of validation.errors) {
      lines.push(`- ${error}`)
    }
    lines.push('')
  }

  if (validation.warnings.length > 0) {
    lines.push('## Warnings', '')
    for (const warning of validation.warnings) {
      lines.push(`- ${warning}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function selectFlowArtifactsPaths(mapId: string, cwd: string): {
  graphPath: string
  endpointsPath: string
  findingsPath: string
  journeysPath: string
  validationPath: string
  checkPath: string
} {
  const baseDir = path.join(getMapDir(mapId, cwd), 'flow')
  return {
    graphPath: path.join(baseDir, 'graph.json'),
    endpointsPath: path.join(baseDir, 'endpoints.json'),
    findingsPath: path.join(baseDir, 'findings.json'),
    journeysPath: path.join(baseDir, 'journeys.json'),
    validationPath: path.join(baseDir, 'validation.json'),
    checkPath: path.join(baseDir, 'check.json'),
  }
}

function nodeLabelFromId(nodeId: string): string {
  const segments = nodeId.split(':')
  if (segments.length < 2) {
    return nodeId
  }

  return segments.slice(1).join(':')
}

function renderFlowchart(nodes: FlowNode[], edges: FlowEdge[]): string {
  const lines: string[] = ['flowchart LR']

  for (const node of nodes.sort((a, b) => a.id.localeCompare(b.id))) {
    const key = node.id.replace(/[^A-Za-z0-9_]/g, '_')
    lines.push(`  ${key}["${node.label.replace(/"/g, '\\"')}"]`)
  }

  for (const edge of edges.sort((a, b) => `${a.from}|${a.to}|${a.type}`.localeCompare(`${b.from}|${b.to}|${b.type}`))) {
    const from = edge.from.replace(/[^A-Za-z0-9_]/g, '_')
    const to = edge.to.replace(/[^A-Za-z0-9_]/g, '_')
    const edgeLabel = `${edge.type} (${edge.protocol}, conf=${edge.confidence})`
    lines.push(`  ${from} -->|"${edgeLabel.replace(/"/g, '\\"')}"| ${to}`)
  }

  return `${lines.join('\n')}\n`
}

function renderJourneySequence(graph: FlowGraphArtifact, journey: FlowJourney): string {
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const participants = new Set<string>()

  for (const edgeId of journey.edgeIds) {
    const edge = edgeById.get(edgeId)
    if (!edge) {
      continue
    }

    participants.add(edge.from)
    participants.add(edge.to)
  }

  const participantLabels = [...participants].sort((a, b) => a.localeCompare(b))
  const lines: string[] = ['sequenceDiagram', '  autonumber']

  if (participantLabels.length === 0) {
    lines.push('  participant unknown as Unknown')
    lines.push('  unknown->>unknown: No journey edges available')
    return `${lines.join('\n')}\n`
  }

  for (const nodeId of participantLabels) {
    const alias = nodeId.replace(/[^A-Za-z0-9_]/g, '_')
    lines.push(`  participant ${alias} as ${nodeLabelFromId(nodeId)}`)
  }

  for (const edgeId of journey.edgeIds) {
    const edge = edgeById.get(edgeId)
    if (!edge) {
      continue
    }

    const from = edge.from.replace(/[^A-Za-z0-9_]/g, '_')
    const to = edge.to.replace(/[^A-Za-z0-9_]/g, '_')
    const label = `${edge.type} [${edge.protocol}]`
    lines.push(`  ${from}->>${to}: ${label}`)
  }

  return `${lines.join('\n')}\n`
}

function canonicalComparableGraph(graph: FlowGraphArtifact): {nodes: FlowNode[]; edges: FlowEdge[]} {
  return {
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

export function loadFlowArtifacts(mapId: string, cwd = process.cwd()): LoadedFlowArtifacts {
  const paths = selectFlowArtifactsPaths(mapId, cwd)

  return {
    graph: fileExists(paths.graphPath) ? readJsonFile<FlowGraphArtifact>(paths.graphPath) : undefined,
    endpoints: fileExists(paths.endpointsPath) ? readJsonFile<EndpointInventoryRecord[]>(paths.endpointsPath) : undefined,
    findings: fileExists(paths.findingsPath) ? readJsonFile<FlowFindingsArtifact>(paths.findingsPath) : undefined,
    journeys: fileExists(paths.journeysPath) ? readJsonFile<FlowJourneysArtifact>(paths.journeysPath) : undefined,
  }
}

export function discoverFlow(options: FlowDiscoverOptions): FlowDiscoverResult {
  const cwd = options.cwd ?? process.cwd()
  const generatedAt = new Date().toISOString()
  const envFilter = options.env ?? 'all'

  const scope = loadScopeManifest(options.mapId, cwd)
  const repos = listAllRepos(options.db)
  const repoMap = new Map(repos.map((repo) => [repo.name, repo]))
  const scopedRepos = scope.effective.filter((repoName) => repoMap.has(repoName))

  const {config} = loadFlowConfig(cwd)
  const {overrides, path: overridesPath} = loadFlowOverrides(options.mapId, cwd)

  if (!fileExists(overridesPath) && !options.dryRun) {
    writeJsonFile(overridesPath, overrides)
  }

  const aliases = serviceAliasMap(config, overrides, scopedRepos)
  const externalAliases = externalAliasMap(config)

  const findings: FlowFinding[] = []
  const ignoredCodes = new Set((config.ignoredFindings ?? []).map((value) => value.trim()))

  const endpointRecords: EndpointInventoryRecord[] = []
  const callSites: RawCallSite[] = []
  const eventSignals: RawEventSignal[] = []
  const storeSignals: RawStoreSignal[] = []
  const repoKinds = new Map<string, 'client' | 'service'>()
  const repoEnvs = new Map<string, Record<string, string>>()

  for (const repoName of scopedRepos) {
    const repo = repoMap.get(repoName)
    if (!repo) {
      continue
    }

    const kind = inferRepoKind(repo)
    repoKinds.set(repoName, kind)
    repoEnvs.set(repoName, collectRepoEnv(repo))

    if (!repo.localPath || !fileExists(repo.localPath)) {
      findings.push({
        id: `finding:${stableHash(`missing_local_clone|${repoName}`)}`,
        code: 'missing_local_clone',
        severity: 'error',
        message: `Repository ${repoName} is in map scope but has no local clone path; flow discovery requires local source traversal.`,
        evidenceRefs: [`repo:${repoName}`],
        service: repoName,
        confidence: 1,
      })
      continue
    }

    const candidates = listFilesRecursive(repo.localPath)
      .map((candidate) => ({
        absolute: candidate,
        relative: toRelative(candidate, repo.localPath!),
      }))
      .filter((candidate) => shouldScanSourceFile(candidate.relative))
      .sort((a, b) => a.relative.localeCompare(b.relative))
      .slice(0, 2_000)

    for (const candidate of candidates) {
      const relative = candidate.relative
      const rawContent = safeReadText(candidate.absolute).slice(0, 200_000)
      const content = stripLikelyComments(relative, rawContent)
      if (!content.trim()) {
        continue
      }

      endpointRecords.push(...extractEndpointsFromContent(repoName, relative, content, config))
      callSites.push(...extractCallSitesFromContent(repoName, kind, relative, content))
      eventSignals.push(...extractEventSignalsFromContent(repoName, relative, content))
      storeSignals.push(...extractStoreSignalsFromContent(repoName, relative, content))
    }
  }

  const endpointByMethodPath = new Map<string, EndpointInventoryRecord[]>()
  for (const endpoint of endpointRecords) {
    const key = `${endpoint.method.toUpperCase()}|${normalizePathForMatch(endpoint.path)}`
    const existing = endpointByMethodPath.get(key) ?? []
    existing.push(endpoint)
    endpointByMethodPath.set(key, existing)
  }

  const contracts = extractContracts(options.mapId, scope, repoMap)
  const contractSignals = collectContractSignals(contracts, repoMap)

  const contractOperationBySignature = new Map<string, ContractOperation>()
  for (const operation of contractSignals.operations) {
    contractOperationBySignature.set(`${operation.service}|${operation.method}|${operation.path}`, operation)
  }

  for (const endpoint of endpointRecords) {
    const operation = contractOperationBySignature.get(`${endpoint.service}|${endpoint.method}|${normalizePathForMatch(endpoint.path)}`)
    if (operation) {
      endpoint.schemaRef = operation.schemaRef
    }
  }

  const nodes = new Map<string, FlowNode>()
  for (const repoName of scopedRepos) {
    const repoKind = repoKinds.get(repoName) ?? 'service'
    if (repoKind === 'client') {
      ensureNode(nodes, {
        id: `client:${repoName}`,
        type: 'client',
        label: repoName,
        service: repoName,
      })
    }

    ensureNode(nodes, {
      id: `service:${repoName}`,
      type: 'service',
      label: repoName,
      service: repoName,
      metadata: {
        owner: overrides.serviceOwnership[repoName] ?? config.serviceOwnershipOverrides?.[repoName],
      },
    })
  }

  for (const endpoint of endpointRecords) {
    ensureNode(nodes, {
      id: endpoint.id,
      type: 'endpoint',
      label: `${endpoint.method} ${endpoint.path}`,
      service: endpoint.service,
      metadata: {
        auth: endpoint.auth,
        version: endpoint.version,
        schemaRef: endpoint.schemaRef,
        sourceFile: endpoint.sourceFile,
        sourceLine: endpoint.sourceLine,
      },
    })
  }

  const edgeAccumulators = new Map<string, EdgeAccumulator>()

  for (const endpoint of endpointRecords) {
    const serviceNode = `service:${endpoint.service}`
    const piiTags = piiTagsFromPath(endpoint.path)

    upsertEdge(edgeAccumulators, {
      type: 'http_call',
      from: endpoint.id,
      to: serviceNode,
      protocol: 'http',
      auth: endpoint.auth,
      payloadSchemaRef: endpoint.schemaRef,
      piiTags,
      evidenceRef: `file:${endpoint.service}:${endpoint.sourceFile}:${endpoint.sourceLine}`,
      source: 'static',
    })
  }

  for (const call of callSites) {
    const callerNode = `${call.callerKind}:${call.callerService}`
    ensureNode(nodes, {
      id: callerNode,
      type: call.callerKind,
      label: call.callerService,
      service: call.callerService,
    })

    const repoEnv = repoEnvs.get(call.callerService) ?? {}
    const resolved = resolveCallTarget({
      call,
      repoEnv,
      endpointByMethodPath,
      aliases,
      externalAliases,
      repos: scopedRepos,
    })

    const evidenceRef = `file:${call.callerService}:${call.sourceFile}:${call.sourceLine}`

    if (resolved.endpoint) {
      const endpointNodeId = resolved.endpoint.id
      upsertEdge(edgeAccumulators, {
        type: call.protocol === 'grpc' ? 'grpc_call' : 'http_call',
        from: callerNode,
        to: endpointNodeId,
        protocol: call.protocol,
        auth: resolved.endpoint.auth,
        payloadSchemaRef: resolved.endpoint.schemaRef,
        piiTags: piiTagsFromPath(resolved.endpoint.path),
        evidenceRef,
        source: 'static',
      })

      if (!resolved.endpoint.schemaRef) {
        findings.push({
          id: `finding:${stableHash(`contract_mismatch:${callerNode}:${endpointNodeId}:${call.sourceFile}:${call.sourceLine}`)}`,
          code: 'contract_mismatch',
          severity: 'warning',
          message: `Call from ${call.callerService} to ${resolved.endpoint.method} ${resolved.endpoint.path} has no bound contract operation.`,
          evidenceRefs: [evidenceRef],
          confidence: 0.72,
          edgeId: `${callerNode}->${endpointNodeId}`,
          service: call.callerService,
        })
      }

      continue
    }

    if (resolved.targetService) {
      const targetNode = `service:${resolved.targetService}`
      upsertEdge(edgeAccumulators, {
        type: call.protocol === 'grpc' ? 'grpc_call' : 'http_call',
        from: callerNode,
        to: targetNode,
        protocol: call.protocol,
        auth: 'unknown',
        evidenceRef,
        source: 'static',
      })

      findings.push({
        id: `finding:${stableHash(`unknown_endpoint_ownership:${callerNode}:${targetNode}:${call.sourceFile}:${call.sourceLine}`)}`,
        code: 'unknown_endpoint_ownership',
        severity: 'warning',
        message: `Call from ${call.callerService} resolved to service ${resolved.targetService} but endpoint ownership is unknown.`,
        evidenceRefs: [evidenceRef],
        confidence: 0.62,
        edgeId: `${callerNode}->${targetNode}`,
        service: call.callerService,
      })
      continue
    }

    if (resolved.targetExternal) {
      const externalNode = `external:${stableHash(resolved.targetExternal.toLowerCase())}`
      ensureNode(nodes, {
        id: externalNode,
        type: 'external',
        label: resolved.targetExternal,
      })

      upsertEdge(edgeAccumulators, {
        type: call.protocol === 'grpc' ? 'grpc_call' : 'http_call',
        from: callerNode,
        to: externalNode,
        protocol: call.protocol,
        auth: 'unknown',
        evidenceRef,
        source: 'static',
      })
      continue
    }

    findings.push({
      id: `finding:${stableHash(`unresolved_base_url:${call.callerService}:${call.sourceFile}:${call.sourceLine}`)}`,
      code: 'unresolved_base_url',
      severity: 'error',
      message: `Could not resolve call target '${call.targetRaw}' in ${call.callerService} (${call.sourceFile}:${call.sourceLine})${
        resolved.unresolvedReason ? ` [${resolved.unresolvedReason}]` : ''
      }.`,
      evidenceRefs: [evidenceRef],
      confidence: 0.78,
      service: call.callerService,
    })
  }

  const channelByServiceAndName = new Map<string, ContractChannel>()
  for (const channel of contractSignals.channels) {
    channelByServiceAndName.set(`${channel.service}|${channel.channel.toLowerCase()}`, channel)
  }

  for (const signal of eventSignals) {
    const normalizedTopic = signal.topic.toLowerCase()
    const eventBusId = `event_bus:${stableHash(normalizedTopic)}`
    ensureNode(nodes, {
      id: eventBusId,
      type: 'event_bus',
      label: signal.topic,
      metadata: {
        hintedBy: EVENT_HINTS.filter((hint) => normalizedTopic.includes(hint)),
      },
    })

    const edgeType: FlowEdgeType = signal.direction === 'publish' ? 'async_publish' : 'async_consume'
    const from = signal.direction === 'publish' ? `service:${signal.service}` : eventBusId
    const to = signal.direction === 'publish' ? eventBusId : `service:${signal.service}`
    const channelMatch = channelByServiceAndName.get(`${signal.service}|${normalizedTopic}`)

    upsertEdge(edgeAccumulators, {
      type: edgeType,
      from,
      to,
      protocol: 'event',
      auth: 'unknown',
      payloadSchemaRef: channelMatch?.schemaRef,
      evidenceRef: `file:${signal.service}:${signal.sourceFile}:${signal.sourceLine}`,
      source: 'static',
    })
  }

  for (const signal of storeSignals) {
    const isCache = signal.type === 'cache_read' || signal.type === 'cache_write'
    const nodeType = isCache ? 'datastore' : 'datastore'
    const storeNodeId = `datastore:${signal.store}`
    ensureNode(nodes, {
      id: storeNodeId,
      type: nodeType,
      label: signal.store,
    })

    upsertEdge(edgeAccumulators, {
      type: signal.type,
      from: `service:${signal.service}`,
      to: storeNodeId,
      protocol: isCache ? 'cache' : 'db',
      auth: 'internal',
      evidenceRef: `file:${signal.service}:${signal.sourceFile}:${signal.sourceLine}`,
      source: 'static',
    })
  }

  const runtimeRecords = collectRuntimeRecords(cwd, options.mapId, config, options.runtimeDir, envFilter)

  for (const runtimeRecord of runtimeRecords) {
    const callerService = runtimeRecord.serviceName
      ? resolveServiceByHost(runtimeRecord.serviceName, aliases, scopedRepos) ?? runtimeRecord.serviceName
      : undefined

    if (!callerService || !scopedRepos.includes(callerService)) {
      continue
    }

    const callerNode = `service:${callerService}`
    ensureNode(nodes, {
      id: callerNode,
      type: 'service',
      label: callerService,
      service: callerService,
    })

    if (runtimeRecord.messagingDestination) {
      const eventBusId = `event_bus:${stableHash(runtimeRecord.messagingDestination.toLowerCase())}`
      ensureNode(nodes, {
        id: eventBusId,
        type: 'event_bus',
        label: runtimeRecord.messagingDestination,
      })

      upsertEdge(edgeAccumulators, {
        type: 'async_publish',
        from: callerNode,
        to: eventBusId,
        protocol: 'event',
        auth: 'unknown',
        evidenceRef: runtimeRecord.evidenceRef,
        source: 'runtime',
        env: runtimeRecord.env,
        seenAt: runtimeRecord.timestamp,
      })
    }

    if (runtimeRecord.dbSystem) {
      const storeNodeId = `datastore:${runtimeRecord.dbSystem}`
      ensureNode(nodes, {
        id: storeNodeId,
        type: 'datastore',
        label: runtimeRecord.dbSystem,
      })

      const dbType: FlowEdgeType = /select|get|query/i.test(runtimeRecord.dbOperation ?? '') ? 'db_read' : 'db_write'
      upsertEdge(edgeAccumulators, {
        type: dbType,
        from: callerNode,
        to: storeNodeId,
        protocol: 'db',
        auth: 'internal',
        evidenceRef: runtimeRecord.evidenceRef,
        source: 'runtime',
        env: runtimeRecord.env,
        seenAt: runtimeRecord.timestamp,
      })
    }

    if (!runtimeRecord.method && !runtimeRecord.url && !runtimeRecord.path) {
      continue
    }

    const method = (runtimeRecord.method ?? 'GET').toUpperCase()
    const pathFromRuntime = runtimeRecord.path
      ? normalizePathForMatch(runtimeRecord.path)
      : runtimeRecord.url
      ? normalizePathForMatch(maybeUrl(runtimeRecord.url)?.pathname ?? '/')
      : '/'

    const methodPathKey = `${method}|${pathFromRuntime}`
    const endpointCandidates = endpointByMethodPath.get(methodPathKey) ?? []
    const peerResolved = runtimeRecord.peerService
      ? resolveServiceByHost(runtimeRecord.peerService, aliases, scopedRepos)
      : undefined
    const urlResolved = runtimeRecord.url
      ? resolveServiceByHost(maybeUrl(runtimeRecord.url.replace(/^grpc:\/\//i, 'http://'))?.host ?? '', aliases, scopedRepos)
      : undefined
    const peerExternal = !peerResolved && runtimeRecord.peerService
      ? resolveExternalByHost(runtimeRecord.peerService, externalAliases)
      : undefined
    const urlExternal = !urlResolved && runtimeRecord.url
      ? resolveExternalByHost(maybeUrl(runtimeRecord.url.replace(/^grpc:\/\//i, 'http://'))?.host ?? '', externalAliases)
      : undefined

    let endpoint: EndpointInventoryRecord | undefined
    if (peerResolved) {
      endpoint = endpointCandidates.find((candidate) => candidate.service === peerResolved)
    }
    if (!endpoint && urlResolved) {
      endpoint = endpointCandidates.find((candidate) => candidate.service === urlResolved)
    }
    if (!endpoint && endpointCandidates.length === 1) {
      endpoint = endpointCandidates[0]
    }

    if (endpoint) {
      upsertEdge(edgeAccumulators, {
        type: runtimeRecord.protocol?.toLowerCase().includes('grpc') ? 'grpc_call' : 'http_call',
        from: callerNode,
        to: endpoint.id,
        protocol: runtimeRecord.protocol?.toLowerCase().includes('grpc') ? 'grpc' : 'http',
        auth: endpoint.auth,
        payloadSchemaRef: endpoint.schemaRef,
        piiTags: piiTagsFromPath(endpoint.path),
        evidenceRef: runtimeRecord.evidenceRef,
        source: 'runtime',
        env: runtimeRecord.env,
        seenAt: runtimeRecord.timestamp,
      })

      if (!endpoint.schemaRef) {
        findings.push({
          id: `finding:${stableHash(`runtime_call_without_contract:${callerNode}:${endpoint.id}:${runtimeRecord.evidenceRef}`)}`,
          code: 'runtime_call_without_contract',
          severity: 'warning',
          message: `Runtime call from ${callerService} to ${endpoint.method} ${endpoint.path} has no linked contract operation.`,
          evidenceRefs: [runtimeRecord.evidenceRef],
          confidence: runtimeRecord.env === 'prod' ? 0.88 : 0.72,
          service: callerService,
        })
      }
      continue
    }

    const targetService = peerResolved ?? urlResolved
    if (targetService) {
      const targetNode = `service:${targetService}`
      ensureNode(nodes, {
        id: targetNode,
        type: 'service',
        label: targetService,
        service: targetService,
      })

      upsertEdge(edgeAccumulators, {
        type: runtimeRecord.protocol?.toLowerCase().includes('grpc') ? 'grpc_call' : 'http_call',
        from: callerNode,
        to: targetNode,
        protocol: runtimeRecord.protocol?.toLowerCase().includes('grpc') ? 'grpc' : 'http',
        auth: 'unknown',
        evidenceRef: runtimeRecord.evidenceRef,
        source: 'runtime',
        env: runtimeRecord.env,
        seenAt: runtimeRecord.timestamp,
      })

      findings.push({
        id: `finding:${stableHash(`unknown_endpoint_ownership:runtime:${callerNode}:${targetNode}:${runtimeRecord.evidenceRef}`)}`,
        code: 'unknown_endpoint_ownership',
        severity: 'error',
        message: `Runtime flow from ${callerService} to ${targetService} lacks endpoint ownership mapping (${method} ${pathFromRuntime}).`,
        evidenceRefs: [runtimeRecord.evidenceRef],
        confidence: runtimeRecord.env === 'prod' ? 0.9 : 0.76,
        service: callerService,
      })
      continue
    }

    const targetExternal = peerExternal ?? urlExternal
    if (targetExternal) {
      const externalNode = `external:${stableHash(targetExternal.toLowerCase())}`
      ensureNode(nodes, {
        id: externalNode,
        type: 'external',
        label: targetExternal,
      })

      upsertEdge(edgeAccumulators, {
        type: runtimeRecord.protocol?.toLowerCase().includes('grpc') ? 'grpc_call' : 'http_call',
        from: callerNode,
        to: externalNode,
        protocol: runtimeRecord.protocol?.toLowerCase().includes('grpc') ? 'grpc' : 'http',
        auth: 'unknown',
        evidenceRef: runtimeRecord.evidenceRef,
        source: 'runtime',
        env: runtimeRecord.env,
        seenAt: runtimeRecord.timestamp,
      })
      continue
    }

    findings.push({
      id: `finding:${stableHash(`unresolved_base_url:runtime:${callerService}:${runtimeRecord.evidenceRef}`)}`,
      code: 'unresolved_base_url',
      severity: 'error',
      message: `Runtime call from ${callerService} could not resolve target service (${method} ${pathFromRuntime}).`,
      evidenceRefs: [runtimeRecord.evidenceRef],
      confidence: runtimeRecord.env === 'prod' ? 0.92 : 0.78,
      service: callerService,
    })
  }

  const nodeIds = new Set(nodes.keys())
  applyFlowOverrides(edgeAccumulators, overrides, nodeIds)

  const edges: FlowEdge[] = [...edgeAccumulators.values()]
    .map((edge) => {
      const comparable = `${edge.type}|${edge.from}|${edge.to}|${edge.protocol}|${edge.payloadSchemaRef ?? ''}`
      return {
        id: `edge:${stableHash(comparable)}`,
        type: edge.type,
        from: edge.from,
        to: edge.to,
        protocol: edge.protocol,
        auth: edge.auth,
        payloadSchemaRef: edge.payloadSchemaRef,
        piiTags: [...edge.piiTags].sort((a, b) => a.localeCompare(b)),
        confidence: confidenceForEdge(edge),
        source: sourceForEdge(edge),
        evidenceRefs: [...edge.evidenceRefs].sort((a, b) => a.localeCompare(b)),
        lastSeenByEnv: edge.lastSeenByEnv,
      }
    })
    .sort((a, b) => {
      const confidenceDelta = b.confidence - a.confidence
      if (confidenceDelta !== 0) {
        return confidenceDelta
      }
      return `${a.type}|${a.from}|${a.to}`.localeCompare(`${b.type}|${b.from}|${b.to}`)
    })

  const edgeIdsWithPayload = new Set(edges.filter((edge) => edge.payloadSchemaRef).map((edge) => edge.payloadSchemaRef!))
  for (const operation of contractSignals.operations) {
    if (edgeIdsWithPayload.has(operation.schemaRef)) {
      continue
    }

    findings.push({
      id: `finding:${stableHash(`contract_without_callers:${operation.schemaRef}`)}`,
      code: 'contract_without_callers',
      severity: 'warning',
      message: `Contract operation ${operation.schemaRef} has no detected callers.`,
      evidenceRefs: [operation.schemaRef],
      confidence: 0.51,
      service: operation.service,
    })
  }

  for (const edge of edges) {
    if (edge.confidence >= 0.45) {
      continue
    }

    findings.push({
      id: `finding:${stableHash(`low_confidence_edge:${edge.id}`)}`,
      code: 'low_confidence_edge',
      severity: 'warning',
      message: `Flow edge ${edge.from} -> ${edge.to} has low confidence (${edge.confidence}).`,
      evidenceRefs: edge.evidenceRefs,
      confidence: edge.confidence,
      edgeId: edge.id,
    })
  }

  const dedupedFindings = dedupeFindings(findings, ignoredCodes)

  const graph: FlowGraphArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    mapId: options.mapId,
    org: scope.org,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
  }

  const findingsArtifact: FlowFindingsArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    mapId: options.mapId,
    org: scope.org,
    findings: dedupedFindings,
  }

  const journeysArtifact: FlowJourneysArtifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    mapId: options.mapId,
    org: scope.org,
    journeys: buildJourneys({
      graph,
      config,
    }),
  }

  const endpoints = endpointRecords
    .map((endpoint) => ({
      ...endpoint,
      path: normalizePathForMatch(endpoint.path),
    }))
    .sort((a, b) => `${a.service}|${a.method}|${a.path}`.localeCompare(`${b.service}|${b.method}|${b.path}`))

  const artifactPaths = selectFlowArtifactsPaths(options.mapId, cwd)

  if (!options.dryRun) {
    writeJsonFile(artifactPaths.graphPath, graph)
    writeJsonFile(artifactPaths.endpointsPath, endpoints)
    writeJsonFile(artifactPaths.findingsPath, findingsArtifact)
    writeJsonFile(artifactPaths.journeysPath, journeysArtifact)
  }

  return {
    mapId: options.mapId,
    generatedAt,
    graphPath: artifactPaths.graphPath,
    endpointsPath: artifactPaths.endpointsPath,
    findingsPath: artifactPaths.findingsPath,
    journeysPath: artifactPaths.journeysPath,
    graph,
    endpoints,
    findings: findingsArtifact,
    journeys: journeysArtifact,
  }
}

export function validateFlow(options: FlowValidateOptions): {
  validation: FlowValidationResult
  validationPath: string
  validationMarkdownPath: string
} {
  const cwd = options.cwd ?? process.cwd()
  const paths = selectFlowArtifactsPaths(options.mapId, cwd)
  const {config} = loadFlowConfig(cwd)

  let graph = fileExists(paths.graphPath) ? readJsonFile<FlowGraphArtifact>(paths.graphPath) : undefined
  let findings = fileExists(paths.findingsPath) ? readJsonFile<FlowFindingsArtifact>(paths.findingsPath) : undefined

  if (!graph || !findings) {
    const discovered = discoverFlow({
      mapId: options.mapId,
      db: options.db,
      cwd,
      dryRun: false,
      env: 'all',
    })
    graph = discovered.graph
    findings = discovered.findings
  }

  const validation = validationFromArtifacts({
    graph,
    findings,
    config,
  })

  writeJsonFile(paths.validationPath, validation)
  const validationMarkdownPath = path.join(path.dirname(paths.validationPath), 'validation.md')
  writeTextFile(validationMarkdownPath, renderValidationMarkdown(validation))

  return {
    validation,
    validationPath: paths.validationPath,
    validationMarkdownPath,
  }
}

export function checkFlow(options: FlowCheckOptions): {
  result: FlowCheckResult
  checkPath: string
} {
  const cwd = options.cwd ?? process.cwd()
  const {config} = loadFlowConfig(cwd)
  const paths = selectFlowArtifactsPaths(options.mapId, cwd)

  const discovered = discoverFlow({
    mapId: options.mapId,
    db: options.db,
    cwd,
    env: options.env ?? 'all',
    runtimeDir: options.runtimeDir,
    dryRun: true,
  })

  const existingGraph = fileExists(paths.graphPath) ? readJsonFile<FlowGraphArtifact>(paths.graphPath) : undefined
  const discoveredComparable = canonicalComparableGraph(discovered.graph)
  const existingComparable = existingGraph ? canonicalComparableGraph(existingGraph) : undefined

  const driftDetected = !existingComparable || JSON.stringify(existingComparable) !== JSON.stringify(discoveredComparable)

  const validation = validationFromArtifacts({
    graph: discovered.graph,
    findings: discovered.findings,
    config,
  })

  const errors = [...validation.errors]
  const warnings = [...validation.warnings]

  if (driftDetected) {
    errors.push('Flow graph drift detected against committed artifacts. Run `sdx flow discover --map <id>` and commit updates.')
  }

  const result: FlowCheckResult = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId: options.mapId,
    passed: errors.length === 0,
    driftDetected,
    validation,
    errors,
    warnings,
    stats: {
      nodeCount: discovered.graph.nodes.length,
      edgeCount: discovered.graph.edges.length,
    },
  }

  writeJsonFile(paths.checkPath, result)
  return {
    result,
    checkPath: paths.checkPath,
  }
}

export function generateFlowDiagrams(options: FlowDiagramOptions): FlowDiagramResult {
  const cwd = options.cwd ?? process.cwd()
  const artifacts = loadFlowArtifacts(options.mapId, cwd)
  if (!artifacts.graph || !artifacts.journeys) {
    throw new Error(`Flow artifacts are missing for map ${options.mapId}. Run \`sdx flow discover --map ${options.mapId}\` first.`)
  }

  const graph = artifacts.graph
  const journeys = artifacts.journeys.journeys

  const outputDir = options.outputDir
    ? path.resolve(cwd, options.outputDir)
    : path.join(cwd, 'docs', 'architecture', options.mapId, 'diagrams', 'flow')

  ensureDir(outputDir)

  const endpointNodes = graph.nodes.filter((node) => node.type === 'service' || node.type === 'endpoint' || node.type === 'external')
  const endpointEdges = graph.edges.filter((edge) => edge.type === 'http_call' || edge.type === 'grpc_call')
  const endpointCommunicationPath = path.join(outputDir, 'endpoint-communication.mmd')
  writeTextFile(endpointCommunicationPath, renderFlowchart(endpointNodes, endpointEdges))

  const clientNodes = graph.nodes.filter((node) => node.type === 'client' || node.type === 'endpoint' || node.type === 'service')
  const clientEdges = graph.edges.filter((edge) => edge.type === 'http_call' || edge.type === 'grpc_call')
  const clientBackendPath = path.join(outputDir, 'client-backend-flow.mmd')
  writeTextFile(clientBackendPath, renderFlowchart(clientNodes, clientEdges))

  const eventNodes = graph.nodes.filter((node) => node.type === 'service' || node.type === 'event_bus' || node.type === 'datastore')
  const eventEdges = graph.edges.filter((edge) => {
    return ['async_publish', 'async_consume', 'db_read', 'db_write', 'cache_read', 'cache_write'].includes(edge.type)
  })
  const eventLineagePath = path.join(outputDir, 'event-data-lineage.mmd')
  writeTextFile(eventLineagePath, renderFlowchart(eventNodes, eventEdges))

  const journeyTargets = options.journey
    ? journeys.filter((journey) => journey.name === options.journey || journey.id === options.journey)
    : journeys.slice(0, 3)

  if (options.journey && journeyTargets.length === 0) {
    throw new Error(`Journey '${options.journey}' not found for map ${options.mapId}.`)
  }

  const journeyPaths: string[] = []
  for (const journey of journeyTargets) {
    const safeName = journey.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || journey.id
    const filePath = path.join(outputDir, `journey-${safeName}.mmd`)
    writeTextFile(filePath, renderJourneySequence(graph, journey))
    journeyPaths.push(filePath)
  }

  return {
    outputDir,
    endpointCommunicationPath,
    clientBackendPath,
    eventLineagePath,
    journeyPaths,
  }
}
