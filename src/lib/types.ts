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
  type: 'service' | 'repo' | 'api' | 'event' | 'datastore' | 'queue' | 'team'
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
  type: 'openapi' | 'graphql' | 'proto' | 'asyncapi'
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
