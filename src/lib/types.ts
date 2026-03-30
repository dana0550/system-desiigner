export type PrimerDimension =
  | 'scalability'
  | 'reliability'
  | 'consistency_model'
  | 'data_design'
  | 'api_style'
  | 'caching'
  | 'async_patterns'
  | 'security'
  | 'observability'
  | 'operational_tradeoffs'

export interface SdxConfig {
  schemaVersion: string
  createdAt: string
  updatedAt: string
  outputRepo: {
    org?: string
    repo?: string
    rootDir: string
  }
  codex: {
    cmd: string
  }
  github: {
    tokenEnv: string
    defaultOrg?: string
  }
}

export interface RepoRecord {
  name: string
  fullName: string
  org: string
  defaultBranch?: string
  archived: boolean
  fork: boolean
  htmlUrl?: string
  localPath?: string
  source: 'github' | 'local' | 'hybrid'
  lastSyncedAt?: string
}

export interface ScopeChange {
  at: string
  action: 'create' | 'include' | 'exclude' | 'remove_override' | 'sync' | 'prompt_apply'
  repos: string[]
  note?: string
}

export interface ScopeManifest {
  schemaVersion: string
  generatedAt: string
  mapId: string
  org: string
  discovered: string[]
  explicitInclude: string[]
  explicitExclude: string[]
  effective: string[]
  history: ScopeChange[]
}

export interface ServiceNode {
  id: string
  type: 'service' | 'repo' | 'api' | 'event' | 'datastore' | 'queue' | 'team' | 'external'
  label: string
  repo?: string
  metadata?: Record<string, unknown>
}

export interface ServiceEdge {
  from: string
  to: string
  relation: 'calls' | 'publishes' | 'consumes' | 'owns' | 'depends_on'
  metadata?: Record<string, unknown>
}

export interface ServiceMapArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  org: string
  repos: string[]
  nodes: ServiceNode[]
  edges: ServiceEdge[]
  coverageTags: PrimerDimension[]
}

export interface ContractRecord {
  schemaVersion: string
  generatedAt: string
  mapId: string
  repo: string
  type: 'openapi' | 'graphql' | 'proto' | 'asyncapi' | 'markdown'
  path: string
  version?: string
  producers: string[]
  consumers: string[]
  compatibilityStatus: 'unknown' | 'non_breaking' | 'potential_breaking'
  sourcePointer: string
}

export interface PlanReviewArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  planPath: string
  missingNfrs: string[]
  accepted: boolean
  decisions: Array<{
    title: string
    rationale: string
    confidence: number
    dimensions: PrimerDimension[]
  }>
  impactedRepos: string[]
  unresolvedAssumptions: string[]
}

export interface HandoffArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  serviceId: string
  targets: Array<{
    repo: string
    summary: string
    requiredChanges: string[]
    contractImpacts: string[]
    sequencing: string
  }>
}

export interface CodexContextPack {
  schemaVersion: string
  generatedAt: string
  mapId: string
  taskType: string
  constraints: string[]
  affectedRepos: string[]
  graphSlice: {
    nodes: ServiceNode[]
    edges: ServiceEdge[]
  }
  inputFile?: string
}

export interface ArchitectureProvenance {
  source: 'inferred' | 'declared' | 'override'
  confidence: number
  evidence: string[]
}

export interface ArchitectureNode extends ServiceNode {
  provenance: ArchitectureProvenance
}

export interface ArchitectureEdge extends ServiceEdge {
  provenance: ArchitectureProvenance
}

export interface ArchitectureServiceMetadata {
  owner?: string
  criticality?: 'low' | 'medium' | 'high' | 'critical'
  businessContext?: string
}

export interface ArchitectureAssertedNode {
  id: string
  type: ServiceNode['type']
  label: string
  metadata?: Record<string, unknown>
}

export interface ArchitectureAssertedEdge {
  from: string
  to: string
  relation: ServiceEdge['relation']
  metadata?: Record<string, unknown>
}

export interface ArchitectureSuppressedEdge {
  from: string
  to: string
  relation: ServiceEdge['relation']
}

export interface ArchitectureOverrides {
  schemaVersion: string
  generatedAt: string
  mapId: string
  serviceMetadata: Record<string, ArchitectureServiceMetadata>
  assertedNodes: ArchitectureAssertedNode[]
  assertedEdges: ArchitectureAssertedEdge[]
  suppressedEdges: ArchitectureSuppressedEdge[]
}

export interface ArchitectureModelArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  org: string
  overridesPath: string
  coverageConfidence: number
  errors: string[]
  warnings: string[]
  nodes: ArchitectureNode[]
  edges: ArchitectureEdge[]
}

export interface ArchitectureValidationResult {
  schemaVersion: string
  generatedAt: string
  mapId: string
  valid: boolean
  errors: string[]
  warnings: string[]
  stats: {
    serviceCount: number
    edgeCount: number
    inferredEdges: number
    overrideEdges: number
  }
}

export type PublishTargetStatus = 'created' | 'updated' | 'skipped' | 'failed'

export interface NoticePublishTargetResult {
  contractChangeId: string
  targetRepoInput: string
  targetRepoResolved?: string
  targetContractChangeId?: string
  owner: string
  stateBefore: string
  stateAfter: string
  status: PublishTargetStatus
  prUrl?: string
  reason?: string
}

export interface NoticePublishContractResult {
  contractChangeId: string
  name: string
  sourceStatusBefore: string
  sourceStatusAfter: string
  eligible: boolean
  sourceSyncPrUrl?: string
  targetResults: NoticePublishTargetResult[]
}

export interface NoticePublishResult {
  schemaVersion: string
  generatedAt: string
  mapId: string
  sourceRepo: string
  contractChangeId?: string
  noticeType: 'contract' | 'service'
  planPath?: string
  dryRun: boolean
  ready: boolean
  maxTargets?: number
  failFastStoppedAt?: string
  totals: {
    created: number
    updated: number
    skipped: number
    failed: number
  }
  contracts: NoticePublishContractResult[]
  sourceSyncPrUrls: string[]
  artifactJsonPath: string
  artifactMarkdownPath: string
}

export interface PublishSyncTargetResult {
  contractChangeId: string
  repo: string
  prUrl: string
  stateBefore: string
  stateAfter: string
  status: 'updated' | 'skipped' | 'failed'
  reason?: string
}

export interface PublishSyncContractResult {
  contractChangeId: string
  name: string
  sourceStatusBefore: string
  sourceStatusAfter: string
  sourceSyncPrUrl?: string
  targetResults: PublishSyncTargetResult[]
}

export interface PublishSyncResult {
  schemaVersion: string
  generatedAt: string
  mapId: string
  sourceRepo: string
  contractChangeId?: string
  dryRun: boolean
  totals: {
    updated: number
    skipped: number
    failed: number
  }
  contracts: PublishSyncContractResult[]
  sourceSyncPrUrls: string[]
  artifactJsonPath: string
  artifactMarkdownPath: string
}

export type FlowNodeType = 'client' | 'endpoint' | 'service' | 'datastore' | 'event_bus' | 'external'
export type FlowEdgeType =
  | 'http_call'
  | 'grpc_call'
  | 'async_publish'
  | 'async_consume'
  | 'db_read'
  | 'db_write'
  | 'cache_read'
  | 'cache_write'
export type FlowSourceType = 'static' | 'runtime' | 'override'
export type FlowEnvironment = 'dev' | 'staging' | 'prod'

export interface EndpointInventoryRecord {
  id: string
  service: string
  method: string
  path: string
  auth: string
  version: string
  schemaRef?: string
  sourceFile: string
  sourceLine: number
}

export interface FlowNode {
  id: string
  type: FlowNodeType
  label: string
  service?: string
  metadata?: Record<string, unknown>
}

export interface FlowEdge {
  id: string
  type: FlowEdgeType
  from: string
  to: string
  protocol: string
  auth: string
  payloadSchemaRef?: string
  piiTags: string[]
  confidence: number
  source: FlowSourceType
  evidenceRefs: string[]
  lastSeenByEnv: Partial<Record<FlowEnvironment, string>>
  metadata?: Record<string, unknown>
}

export interface FlowGraphArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  org: string
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface FlowFinding {
  id: string
  code:
    | 'missing_local_clone'
    | 'unresolved_base_url'
    | 'unknown_endpoint_ownership'
    | 'contract_mismatch'
    | 'runtime_call_without_contract'
    | 'contract_without_callers'
    | 'stale_runtime_evidence'
    | 'low_confidence_edge'
  severity: 'error' | 'warning'
  message: string
  evidenceRefs: string[]
  confidence?: number
  service?: string
  edgeId?: string
}

export interface FlowFindingsArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  org: string
  findings: FlowFinding[]
}

export interface FlowJourney {
  id: string
  name: string
  source: 'manual' | 'auto'
  score: number
  edgeIds: string[]
  notes?: string
}

export interface FlowJourneysArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  org: string
  journeys: FlowJourney[]
}

export interface FlowValidationResult {
  schemaVersion: string
  generatedAt: string
  mapId: string
  valid: boolean
  errors: string[]
  warnings: string[]
  stats: {
    nodeCount: number
    edgeCount: number
    endpointCount: number
    runtimeBackedEdges: number
  }
}

export interface FlowCheckResult {
  schemaVersion: string
  generatedAt: string
  mapId: string
  passed: boolean
  driftDetected: boolean
  validation: FlowValidationResult
  errors: string[]
  warnings: string[]
  stats: {
    edgeCount: number
    nodeCount: number
  }
}
