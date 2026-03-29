import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {z} from 'zod'
import {SCHEMA_VERSION} from './constants'
import {extractContracts} from './contracts'
import {listFilesRecursive} from './fileScan'
import {fileExists, readJsonFile, writeJsonFile, writeTextFile} from './fs'
import {buildServiceMapArtifact} from './mapBuilder'
import {getMapDir} from './paths'
import {listAllRepos} from './repoRegistry'
import {loadScopeManifest} from './scope'
import {
  ArchitectureModelArtifact,
  ArchitectureNode,
  ArchitectureOverrides,
  ArchitectureValidationResult,
  ContractRecord,
  RepoRecord,
  ServiceEdge,
  ServiceNode,
} from './types'

const DATASTORE_KEYWORDS = ['postgres', 'mysql', 'mongodb', 'mongo', 'dynamodb', 'redis', 'cassandra', 'sqlite']
const QUEUE_KEYWORDS = ['kafka', 'sqs', 'sns', 'rabbitmq', 'nats', 'pubsub', 'pulsar', 'kinesis']

const OVERRIDES_SCHEMA = z.object({
  schemaVersion: z.string().optional(),
  generatedAt: z.string().optional(),
  mapId: z.string().optional(),
  serviceMetadata: z
    .record(
      z.string(),
      z.object({
        owner: z.string().optional(),
        criticality: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        businessContext: z.string().optional(),
      }),
    )
    .default({}),
  assertedNodes: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.enum(['service', 'repo', 'api', 'event', 'datastore', 'queue', 'team', 'external']),
        label: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  assertedEdges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        relation: z.enum(['calls', 'publishes', 'consumes', 'owns', 'depends_on']),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .default([]),
  suppressedEdges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        relation: z.enum(['calls', 'publishes', 'consumes', 'owns', 'depends_on']),
      }),
    )
    .default([]),
})

export interface ArchitectureGenerateOptions {
  mapId: string
  db: Database.Database
  cwd?: string
  depth?: 'org' | 'full'
  serviceId?: string
}

export interface ArchitectureGenerateResult {
  modelPath: string
  overridesPath: string
  baselineArtifacts: {
    serviceMapPath: string
    contractsPath: string
    architectureDocPath: string
  }
  indexDocPath?: string
  overviewPath?: string
  serviceDocPaths: string[]
  generatedServices: string[]
  generatedAt: string
  validation: ArchitectureValidationResult
}

export interface ArchitectureValidateOptions {
  mapId: string
  db: Database.Database
  cwd?: string
}

function toNodeRef(input: string, nodes: Map<string, ArchitectureNode>): string | undefined {
  if (nodes.has(input)) {
    return input
  }

  const serviceRef = `service:${input}`
  if (nodes.has(serviceRef)) {
    return serviceRef
  }

  const repoRef = `repo:${input}`
  if (nodes.has(repoRef)) {
    return repoRef
  }

  const externalRef = `external:${input}`
  if (nodes.has(externalRef)) {
    return externalRef
  }

  return undefined
}

function dedupeNodes(nodes: ArchitectureNode[]): ArchitectureNode[] {
  const byId = new Map<string, ArchitectureNode>()
  for (const node of nodes) {
    const existing = byId.get(node.id)
    if (!existing) {
      byId.set(node.id, node)
      continue
    }

    byId.set(node.id, {
      ...existing,
      label: node.label,
      type: node.type,
      metadata: {
        ...(existing.metadata ?? {}),
        ...(node.metadata ?? {}),
      },
      provenance:
        node.provenance.source === 'override' || existing.provenance.source !== 'override' ? node.provenance : existing.provenance,
    })
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function dedupeEdges(edges: ArchitectureModelArtifact['edges']): ArchitectureModelArtifact['edges'] {
  const byKey = new Map<string, ArchitectureModelArtifact['edges'][number]>()

  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.relation}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, edge)
      continue
    }

    byKey.set(key, {
      ...existing,
      metadata: {
        ...(existing.metadata ?? {}),
        ...(edge.metadata ?? {}),
      },
      provenance:
        edge.provenance.source === 'override' || existing.provenance.source !== 'override' ? edge.provenance : existing.provenance,
    })
  }

  return [...byKey.values()].sort((a, b) => {
    const left = `${a.from}|${a.to}|${a.relation}`
    const right = `${b.from}|${b.to}|${b.relation}`
    return left.localeCompare(right)
  })
}

function keywordMatches(allFiles: string[], keywords: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const filePath of allFiles) {
    const lower = filePath.toLowerCase()
    for (const keyword of keywords) {
      if (!lower.includes(keyword)) {
        continue
      }

      const previous = out.get(keyword) ?? []
      if (previous.length < 3) {
        previous.push(filePath)
      }
      out.set(keyword, previous)
    }
  }

  return out
}

function inferInfra(
  repo: RepoRecord,
  nodes: ArchitectureNode[],
  edges: ArchitectureModelArtifact['edges'],
): void {
  if (!repo.localPath || !fs.existsSync(repo.localPath)) {
    return
  }

  const files = listFilesRecursive(repo.localPath)
  const serviceNodeId = `service:${repo.name}`

  const dataStoreHits = keywordMatches(files, DATASTORE_KEYWORDS)
  for (const [keyword, hitFiles] of dataStoreHits.entries()) {
    const nodeId = `datastore:${keyword}`
    nodes.push({
      id: nodeId,
      type: 'datastore',
      label: keyword,
      metadata: {
        inferredFrom: hitFiles.map((candidate) => path.relative(repo.localPath!, candidate)),
      },
      provenance: {
        source: 'inferred',
        confidence: 0.6,
        evidence: [`repo:${repo.name}:keyword:${keyword}`],
      },
    })

    edges.push({
      from: serviceNodeId,
      to: nodeId,
      relation: 'depends_on',
      provenance: {
        source: 'inferred',
        confidence: 0.6,
        evidence: [`repo:${repo.name}:keyword:${keyword}`],
      },
      metadata: {
        inferredFrom: 'file_keyword_scan',
      },
    })
  }

  const queueHits = keywordMatches(files, QUEUE_KEYWORDS)
  for (const [keyword, hitFiles] of queueHits.entries()) {
    const nodeId = `queue:${keyword}`
    nodes.push({
      id: nodeId,
      type: 'queue',
      label: keyword,
      metadata: {
        inferredFrom: hitFiles.map((candidate) => path.relative(repo.localPath!, candidate)),
      },
      provenance: {
        source: 'inferred',
        confidence: 0.6,
        evidence: [`repo:${repo.name}:keyword:${keyword}`],
      },
    })

    edges.push({
      from: serviceNodeId,
      to: nodeId,
      relation: 'depends_on',
      provenance: {
        source: 'inferred',
        confidence: 0.6,
        evidence: [`repo:${repo.name}:keyword:${keyword}`],
      },
      metadata: {
        inferredFrom: 'file_keyword_scan',
      },
    })
  }
}

function contractNodeId(contract: ContractRecord): string {
  const prefix = contract.type === 'asyncapi' ? 'event' : 'api'
  return `${prefix}:${contract.repo}:${contract.path}`
}

function addConsumerSignals(
  contracts: ContractRecord[],
  baseEdges: ServiceEdge[],
  nodes: ArchitectureNode[],
  edges: ArchitectureModelArtifact['edges'],
): void {
  const byRepo = new Map<string, ContractRecord[]>()
  for (const contract of contracts) {
    const entries = byRepo.get(contract.repo) ?? []
    entries.push(contract)
    byRepo.set(contract.repo, entries)
  }

  const hasNode = new Set(nodes.map((node) => node.id))

  for (const relation of baseEdges) {
    if (relation.relation !== 'depends_on' || !relation.from.startsWith('service:') || !relation.to.startsWith('service:')) {
      continue
    }

    const sourceRepo = relation.from.slice('service:'.length)
    const targetRepo = relation.to.slice('service:'.length)
    const targetContracts = byRepo.get(targetRepo) ?? []

    if (targetContracts.length === 0) {
      continue
    }

    edges.push({
      from: relation.from,
      to: relation.to,
      relation: 'calls',
      provenance: {
        source: 'inferred',
        confidence: 0.7,
        evidence: [`dependency:${sourceRepo}->${targetRepo}`],
      },
      metadata: {
        inferredFrom: 'dependency_plus_contract',
      },
    })

    for (const contract of targetContracts) {
      const targetNodeId = contractNodeId(contract)
      if (!hasNode.has(targetNodeId)) {
        continue
      }

      edges.push({
        from: relation.from,
        to: targetNodeId,
        relation: contract.type === 'asyncapi' ? 'consumes' : 'calls',
        provenance: {
          source: 'inferred',
          confidence: 0.55,
          evidence: [`dependency:${sourceRepo}->${targetRepo}`, `contract:${contract.path}`],
        },
        metadata: {
          inferredFrom: 'dependency_plus_contract',
        },
      })
    }
  }
}

function defaultOverrides(mapId: string): ArchitectureOverrides {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    serviceMetadata: {},
    assertedNodes: [],
    assertedEdges: [],
    suppressedEdges: [],
  }
}

export function getArchitectureOverridesPath(mapId: string, cwd = process.cwd()): string {
  return path.join(getMapDir(mapId, cwd), 'architecture-overrides.json')
}

export function ensureArchitectureOverridesFile(mapId: string, cwd = process.cwd()): string {
  const overridesPath = getArchitectureOverridesPath(mapId, cwd)
  if (fileExists(overridesPath)) {
    return overridesPath
  }

  writeJsonFile(overridesPath, defaultOverrides(mapId))
  return overridesPath
}

export function loadArchitectureOverrides(mapId: string, cwd = process.cwd()): ArchitectureOverrides {
  const overridesPath = ensureArchitectureOverridesFile(mapId, cwd)
  const payload = readJsonFile<unknown>(overridesPath)
  const parsed = OVERRIDES_SCHEMA.parse(payload)

  return {
    schemaVersion: parsed.schemaVersion ?? SCHEMA_VERSION,
    generatedAt: parsed.generatedAt ?? new Date().toISOString(),
    mapId: parsed.mapId ?? mapId,
    serviceMetadata: parsed.serviceMetadata as ArchitectureOverrides['serviceMetadata'],
    assertedNodes: parsed.assertedNodes,
    assertedEdges: parsed.assertedEdges,
    suppressedEdges: parsed.suppressedEdges,
  }
}

function applyOverrides(
  overrides: ArchitectureOverrides,
  modelNodes: ArchitectureNode[],
  modelEdges: ArchitectureModelArtifact['edges'],
): {nodes: ArchitectureNode[]; edges: ArchitectureModelArtifact['edges']; errors: string[]; warnings: string[]} {
  const errors: string[] = []
  const warnings: string[] = []
  const nodes = [...modelNodes]
  const edges = [...modelEdges]

  const nodeMap = new Map(nodes.map((node) => [node.id, node]))

  for (const [serviceName, metadata] of Object.entries(overrides.serviceMetadata)) {
    const id = `service:${serviceName}`
    const node = nodeMap.get(id)
    if (!node) {
      errors.push(`Override serviceMetadata references unknown service '${serviceName}'.`)
      continue
    }

    node.metadata = {
      ...(node.metadata ?? {}),
      ...metadata,
    }

    node.provenance = {
      source: 'declared',
      confidence: Math.max(node.provenance.confidence, 0.9),
      evidence: [...new Set([...node.provenance.evidence, `override:serviceMetadata:${serviceName}`])],
    }
    nodeMap.set(id, node)
  }

  for (const assertedNode of overrides.assertedNodes) {
    const existing = nodeMap.get(assertedNode.id)
    if (existing) {
      if (existing.type !== assertedNode.type) {
        errors.push(
          `assertedNode '${assertedNode.id}' conflicts with existing type '${existing.type}' (override type '${assertedNode.type}').`,
        )
        continue
      }

      existing.label = assertedNode.label
      existing.metadata = {
        ...(existing.metadata ?? {}),
        ...(assertedNode.metadata ?? {}),
      }
      existing.provenance = {
        source: 'override',
        confidence: 0.98,
        evidence: [...new Set([...existing.provenance.evidence, `override:assertedNode:${assertedNode.id}`])],
      }
      nodeMap.set(assertedNode.id, existing)
      continue
    }

    const created: ArchitectureNode = {
      ...assertedNode,
      provenance: {
        source: 'override',
        confidence: 0.98,
        evidence: [`override:assertedNode:${assertedNode.id}`],
      },
    }
    nodeMap.set(created.id, created)
  }

  const resolvedNodes = [...nodeMap.values()]
  const resolvedNodeMap = new Map(resolvedNodes.map((node) => [node.id, node]))

  const resolvedEdges = [...edges]
  for (const assertedEdge of overrides.assertedEdges) {
    const from = toNodeRef(assertedEdge.from, resolvedNodeMap)
    const to = toNodeRef(assertedEdge.to, resolvedNodeMap)

    if (!from || !to) {
      errors.push(
        `assertedEdge '${assertedEdge.from} -> ${assertedEdge.to}' references unknown node(s). Add assertedNodes first or use canonical IDs.`,
      )
      continue
    }

    resolvedEdges.push({
      from,
      to,
      relation: assertedEdge.relation,
      metadata: {
        ...(assertedEdge.metadata ?? {}),
        inferredFrom: 'override_asserted_edge',
      },
      provenance: {
        source: 'override',
        confidence: 0.98,
        evidence: [`override:assertedEdge:${from}|${to}|${assertedEdge.relation}`],
      },
    })
  }

  for (const suppressed of overrides.suppressedEdges) {
    const from = toNodeRef(suppressed.from, resolvedNodeMap)
    const to = toNodeRef(suppressed.to, resolvedNodeMap)
    if (!from || !to) {
      errors.push(
        `suppressedEdge '${suppressed.from} -> ${suppressed.to}' references unknown node(s). Use canonical IDs or add assertedNodes first.`,
      )
      continue
    }

    const before = resolvedEdges.length
    for (let i = resolvedEdges.length - 1; i >= 0; i -= 1) {
      const edge = resolvedEdges[i]
      if (edge.from === from && edge.to === to && edge.relation === suppressed.relation) {
        resolvedEdges.splice(i, 1)
      }
    }

    if (before === resolvedEdges.length) {
      warnings.push(`suppressedEdge '${from} -> ${to} (${suppressed.relation})' did not match any existing edge.`)
    }
  }

  return {
    nodes: dedupeNodes([...resolvedNodes]),
    edges: dedupeEdges(resolvedEdges),
    errors,
    warnings,
  }
}

export function buildArchitectureModel(
  mapId: string,
  db: Database.Database,
  cwd = process.cwd(),
): ArchitectureModelArtifact {
  const scope = loadScopeManifest(mapId, cwd)
  const repoMap = new Map(listAllRepos(db).map((repo) => [repo.name, repo]))
  const serviceMap = buildServiceMapArtifact(mapId, scope, repoMap)
  const contracts = extractContracts(mapId, scope, repoMap)

  const nodes: ArchitectureNode[] = serviceMap.nodes.map((node) => ({
    ...node,
    provenance: {
      source: 'inferred',
      confidence: node.type === 'service' || node.type === 'repo' ? 0.95 : 0.8,
      evidence: [`service-map:${node.id}`],
    },
  }))

  const edges: ArchitectureModelArtifact['edges'] = serviceMap.edges.map((edge) => ({
    ...edge,
    provenance: {
      source: 'inferred',
      confidence: edge.relation === 'owns' ? 0.95 : 0.75,
      evidence: [`service-map:${edge.from}->${edge.to}:${edge.relation}`],
    },
  }))

  const warnings: string[] = []
  for (const repoName of scope.effective) {
    const repo = repoMap.get(repoName)
    if (!repo?.localPath || !fs.existsSync(repo.localPath)) {
      warnings.push(`Repository '${repoName}' is in scope but has no local path; deep inference may be partial.`)
      continue
    }

    inferInfra(repo, nodes, edges)
  }

  addConsumerSignals(contracts, serviceMap.edges, nodes, edges)

  const overridesPath = ensureArchitectureOverridesFile(mapId, cwd)
  const overrides = loadArchitectureOverrides(mapId, cwd)
  const applied = applyOverrides(overrides, dedupeNodes(nodes), dedupeEdges(edges))

  warnings.push(...applied.warnings)

  const confidences = applied.edges.map((edge) => edge.provenance.confidence)
  const coverageConfidence = confidences.length === 0 ? 0 : Number((confidences.reduce((sum, c) => sum + c, 0) / confidences.length).toFixed(3))

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    org: scope.org,
    overridesPath: path.relative(cwd, overridesPath),
    coverageConfidence,
    errors: applied.errors,
    warnings,
    nodes: applied.nodes,
    edges: applied.edges,
  }
}

function modelValidation(model: ArchitectureModelArtifact, contracts: ContractRecord[]): ArchitectureValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  const services = model.nodes.filter((node) => node.type === 'service')
  const serviceContracts = new Set(contracts.map((record) => record.repo))

  for (const service of services) {
    const relations = model.edges.filter((edge) => edge.from === service.id || edge.to === service.id)
    const nonOwnership = relations.filter((edge) => edge.relation !== 'owns')
    if (nonOwnership.length === 0) {
      warnings.push(`Service '${service.label}' has no communication edges outside ownership links.`)
    }

    if (!serviceContracts.has(service.label)) {
      warnings.push(`Service '${service.label}' has no detected contract files.`)
    }
  }

  for (const signal of model.errors) {
    errors.push(signal)
  }

  const inferredEdges = model.edges.filter((edge) => edge.provenance.source === 'inferred').length
  const overrideEdges = model.edges.filter((edge) => edge.provenance.source === 'override').length

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId: model.mapId,
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      serviceCount: services.length,
      edgeCount: model.edges.length,
      inferredEdges,
      overrideEdges,
    },
  }
}

function mermaidId(nodeId: string): string {
  return nodeId.replace(/[^a-zA-Z0-9_]/g, '_')
}

function renderMermaid(
  nodes: ArchitectureNode[],
  edges: ArchitectureModelArtifact['edges'],
  title?: string,
): string {
  const lines: string[] = ['flowchart LR']
  if (title) {
    lines.push(`  %% ${title}`)
  }

  for (const node of nodes) {
    lines.push(`  ${mermaidId(node.id)}["${node.label}"]`)
  }

  for (const edge of edges) {
    lines.push(`  ${mermaidId(edge.from)} -->|"${edge.relation}"| ${mermaidId(edge.to)}`)
  }

  return `${lines.join('\n')}\n`
}

function renderArchitectureIndexMarkdown(
  mapId: string,
  model: ArchitectureModelArtifact,
  validation: ArchitectureValidationResult,
  systemLandscapeMermaid: string,
  containerMermaid: string,
  services: ArchitectureNode[],
): string {
  const lines = [
    `# Architecture Pack: ${mapId}`,
    '',
    `- Generated: ${model.generatedAt}`,
    `- Coverage confidence: ${model.coverageConfidence}`,
    `- Override file: ${model.overridesPath}`,
    `- Services: ${services.length}`,
    `- Nodes: ${model.nodes.length}`,
    `- Edges: ${model.edges.length}`,
    '',
    '## Facts vs Inferred',
    '',
    '- Facts: repository scope, discovered contracts, registered repos/local paths.',
    '- Inferred: communication edges from dependency/config signals.',
    '- Overrides: explicit asserted/suppressed relationships from architecture-overrides.json.',
    '',
    '## Validation',
    '',
    `- Valid: ${validation.valid ? 'yes' : 'no'}`,
    `- Errors: ${validation.errors.length}`,
    `- Warnings: ${validation.warnings.length}`,
    '',
  ]

  if (validation.errors.length > 0) {
    lines.push('### Validation Errors')
    lines.push('')
    for (const err of validation.errors) {
      lines.push(`- ${err}`)
    }
    lines.push('')
  }

  if (validation.warnings.length > 0) {
    lines.push('### Validation Warnings')
    lines.push('')
    for (const warning of validation.warnings.slice(0, 30)) {
      lines.push(`- ${warning}`)
    }
    lines.push('')
  }

  lines.push('## System Landscape')
  lines.push('')
  lines.push('```mermaid')
  lines.push(systemLandscapeMermaid.trimEnd())
  lines.push('```')
  lines.push('')
  lines.push('## Container Communication')
  lines.push('')
  lines.push('```mermaid')
  lines.push(containerMermaid.trimEnd())
  lines.push('```')
  lines.push('')
  lines.push('## Service Deep Dives')
  lines.push('')

  for (const service of services) {
    const serviceId = service.id.replace('service:', '')
    lines.push(`- [${service.label}](./services/${serviceId}.md)`)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderServiceDoc(
  service: ArchitectureNode,
  contracts: ContractRecord[],
  contextDiagram: string,
  contractDiagram: string,
  model: ArchitectureModelArtifact,
): string {
  const serviceId = service.id.replace('service:', '')
  const serviceContracts = contracts.filter((contract) => contract.repo === serviceId)
  const relatedEdges = model.edges.filter((edge) => edge.from === service.id || edge.to === service.id)
  const repoNode = model.nodes.find((node) => node.id === `repo:${serviceId}`)
  const repoPath = String(repoNode?.metadata?.['localPath'] ?? 'not-registered')
  const repoHtmlUrl = typeof repoNode?.metadata?.['htmlUrl'] === 'string' ? String(repoNode.metadata['htmlUrl']) : undefined
  const defaultBranch =
    typeof repoNode?.metadata?.['defaultBranch'] === 'string' && String(repoNode.metadata['defaultBranch']).length > 0
      ? String(repoNode.metadata['defaultBranch'])
      : 'main'

  const consumersByContract = new Map<string, string[]>()
  for (const edge of model.edges) {
    if (!edge.to.startsWith('api:') && !edge.to.startsWith('event:')) {
      continue
    }

    if (!edge.from.startsWith('service:')) {
      continue
    }

    const consumer = edge.from.replace('service:', '')
    const current = consumersByContract.get(edge.to) ?? []
    if (!current.includes(consumer)) {
      current.push(consumer)
    }
    consumersByContract.set(edge.to, current.sort((a, b) => a.localeCompare(b)))
  }

  function contractSource(contract: ContractRecord): string {
    if (!repoHtmlUrl) {
      return `\`${contract.sourcePointer}\``
    }

    const url = `${repoHtmlUrl.replace(/\/$/, '')}/blob/${defaultBranch}/${contract.path}`
    return `[${contract.path}](${url})`
  }

  const lines = [
    `# Service Architecture: ${service.label}`,
    '',
    `- Generated: ${model.generatedAt}`,
    `- Map: ${model.mapId}`,
    `- Coverage confidence: ${model.coverageConfidence}`,
    `- Owner: ${String(service.metadata?.['owner'] ?? 'unknown')}`,
    `- Criticality: ${String(service.metadata?.['criticality'] ?? 'unknown')}`,
    `- Business context: ${String(service.metadata?.['businessContext'] ?? 'not declared')}`,
    `- Repo path: ${repoPath}`,
    '',
    '## Facts vs Inferred',
    '',
    '- Facts: service membership, contract files, explicit overrides.',
    '- Inferred: integration relationships from dependencies and config signals.',
    '',
    '## Service Context Diagram',
    '',
    '```mermaid',
    contextDiagram.trimEnd(),
    '```',
    '',
    '## Contract Interaction Diagram',
    '',
    '```mermaid',
    contractDiagram.trimEnd(),
    '```',
    '',
    '## Contract Catalog',
    '',
    '| Type | Contract | Version | Compatibility | Producers | Consumers |',
    '|---|---|---|---|---|---|',
    ...serviceContracts.map(
      (contract) => {
        const consumers = consumersByContract.get(contractNodeId(contract)) ?? []
        return `| ${contract.type} | ${contractSource(contract)} | ${contract.version ?? '-'} | ${contract.compatibilityStatus} | ${contract.producers.join(', ') || '-'} | ${consumers.join(', ') || '-'} |`
      },
    ),
    '',
    '## Migration Guidance',
    '',
    '- Review the source contract docs linked above for rollout and compatibility instructions.',
    '- Validate all consuming services against changed contract versions before cutover.',
    '',
    '## Integration Signals',
    '',
    ...relatedEdges.map(
      (edge) =>
        `- ${edge.from} ${edge.relation} ${edge.to} (source=${edge.provenance.source}, confidence=${edge.provenance.confidence})`,
    ),
    '',
  ]

  return `${lines.join('\n')}\n`
}

function serviceNodes(model: ArchitectureModelArtifact): ArchitectureNode[] {
  return model.nodes
    .filter((node) => node.type === 'service')
    .sort((a, b) => a.label.localeCompare(b.label))
}

function renderSystemLandscape(model: ArchitectureModelArtifact): string {
  const allowedTypes = new Set(['service', 'external', 'datastore', 'queue', 'team'])
  const nodes = model.nodes.filter((node) => allowedTypes.has(node.type))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = model.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  return renderMermaid(nodes, edges, 'System Landscape')
}

function renderContainerCommunication(model: ArchitectureModelArtifact): string {
  const allowedTypes = new Set(['service', 'api', 'event', 'datastore', 'queue', 'external'])
  const nodes = model.nodes.filter((node) => allowedTypes.has(node.type))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = model.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  return renderMermaid(nodes, edges, 'Container Communication')
}

function renderServiceContextDiagram(model: ArchitectureModelArtifact, serviceId: string): string {
  const serviceNodeId = `service:${serviceId}`
  const included = new Set<string>([serviceNodeId])

  for (const edge of model.edges) {
    if (edge.from === serviceNodeId) {
      included.add(edge.to)
    }

    if (edge.to === serviceNodeId) {
      included.add(edge.from)
    }
  }

  const disallowed = new Set(['api', 'event', 'repo'])
  const nodes = model.nodes.filter((node) => included.has(node.id) && !disallowed.has(node.type))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = model.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
  return renderMermaid(nodes, edges, `Service Context: ${serviceId}`)
}

function renderServiceContractsDiagram(model: ArchitectureModelArtifact, serviceId: string): string {
  const serviceNodeId = `service:${serviceId}`
  const ownedContracts = new Set<string>()

  for (const edge of model.edges) {
    if (edge.from !== serviceNodeId) {
      continue
    }

    if (!edge.to.startsWith('api:') && !edge.to.startsWith('event:')) {
      continue
    }

    ownedContracts.add(edge.to)
  }

  const included = new Set<string>([serviceNodeId, ...ownedContracts])
  for (const edge of model.edges) {
    if (ownedContracts.has(edge.to)) {
      included.add(edge.from)
    }
  }

  const nodes = model.nodes.filter((node) => included.has(node.id))
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = model.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))

  return renderMermaid(nodes, edges, `Service Contracts: ${serviceId}`)
}

export function validateArchitecture(options: ArchitectureValidateOptions): ArchitectureValidationResult {
  const cwd = options.cwd ?? process.cwd()
  const mapId = options.mapId
  const model = buildArchitectureModel(mapId, options.db, cwd)

  const scope = loadScopeManifest(mapId, cwd)
  const repoMap = new Map(listAllRepos(options.db).map((repo) => [repo.name, repo]))
  const contracts = extractContracts(mapId, scope, repoMap)

  return modelValidation(model, contracts)
}

export function generateArchitecturePack(options: ArchitectureGenerateOptions): ArchitectureGenerateResult {
  const cwd = options.cwd ?? process.cwd()
  const depth = options.depth ?? 'full'
  const mapId = options.mapId

  const model = buildArchitectureModel(mapId, options.db, cwd)
  const scope = loadScopeManifest(mapId, cwd)
  const repoMap = new Map(listAllRepos(options.db).map((repo) => [repo.name, repo]))
  const contracts = extractContracts(mapId, scope, repoMap)
  const validation = modelValidation(model, contracts)

  const mapArchitectureDir = path.join(getMapDir(mapId, cwd), 'architecture')
  const docsDir = path.join(cwd, 'docs', 'architecture', mapId)
  const diagramsDir = path.join(docsDir, 'diagrams')
  const servicesDocsDir = path.join(docsDir, 'services')

  const modelPath = path.join(mapArchitectureDir, 'model.json')
  const validationPath = path.join(mapArchitectureDir, 'validation.json')
  const overridesPath = ensureArchitectureOverridesFile(mapId, cwd)

  writeJsonFile(modelPath, model)
  writeJsonFile(validationPath, validation)

  const systemLandscape = renderSystemLandscape(model)
  const containerCommunication = renderContainerCommunication(model)

  const systemLandscapePath = path.join(diagramsDir, 'system-landscape.mmd')
  const containerPath = path.join(diagramsDir, 'container-communication.mmd')

  const output: ArchitectureGenerateResult = {
    modelPath,
    overridesPath,
    baselineArtifacts: {
      serviceMapPath: path.join(cwd, 'maps', mapId, 'service-map.json'),
      contractsPath: path.join(cwd, 'maps', mapId, 'contracts.json'),
      architectureDocPath: path.join(cwd, 'docs', 'architecture', `${mapId}.md`),
    },
    serviceDocPaths: [],
    generatedServices: [],
    generatedAt: model.generatedAt,
    validation,
    indexDocPath: undefined,
    overviewPath: undefined,
  }

  if (!options.serviceId) {
    writeTextFile(systemLandscapePath, systemLandscape)
    writeTextFile(containerPath, containerCommunication)

    const services = serviceNodes(model)
    const indexMarkdown = renderArchitectureIndexMarkdown(
      mapId,
      model,
      validation,
      systemLandscape,
      containerCommunication,
      services,
    )

    const indexDocPath = path.join(docsDir, 'index.md')
    const overviewPath = path.join(mapArchitectureDir, 'overview.md')
    writeTextFile(indexDocPath, indexMarkdown)
    writeTextFile(overviewPath, indexMarkdown)

    output.indexDocPath = indexDocPath
    output.overviewPath = overviewPath
  }

  if (depth !== 'org') {
    const services = serviceNodes(model)
      .map((node) => node.id.replace('service:', ''))
      .filter((serviceId) => (options.serviceId ? serviceId === options.serviceId : true))

    if (options.serviceId && services.length === 0) {
      throw new Error(`Unknown service '${options.serviceId}' for map '${mapId}'.`)
    }

    for (const serviceId of services) {
      const serviceNode = model.nodes.find((node) => node.id === `service:${serviceId}`)
      if (!serviceNode) {
        continue
      }

      const contextMermaid = renderServiceContextDiagram(model, serviceId)
      const contractsMermaid = renderServiceContractsDiagram(model, serviceId)
      const serviceDoc = renderServiceDoc(serviceNode, contracts, contextMermaid, contractsMermaid, model)

      const serviceDocPath = path.join(servicesDocsDir, `${serviceId}.md`)
      const serviceDiagramDir = path.join(servicesDocsDir, serviceId)
      writeTextFile(serviceDocPath, serviceDoc)
      writeTextFile(path.join(serviceDiagramDir, 'context.mmd'), contextMermaid)
      writeTextFile(path.join(serviceDiagramDir, 'contracts.mmd'), contractsMermaid)

      output.serviceDocPaths.push(serviceDocPath)
      output.generatedServices.push(serviceId)
    }
  }

  return output
}
