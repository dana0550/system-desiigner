import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {SCHEMA_VERSION} from './constants'
import {
  computeContractChangeStatus,
  ContractChangeDoc,
  ContractChangeIndexMeta,
  ContractChangeIndexRow,
  ContractTargetRow,
  hasContractChangeIndexShape,
  hasRequiredTargetContext,
  isNotifiableContractStatus,
  nextContractChangeId,
  parseContractChangeIndexText,
  readContractChangeDoc,
  renderContractChangeDoc,
  renderContractChangeIndex,
} from './contractChanges'
import {writeJsonFile, writeTextFile} from './fs'
import {createGithubPublishOps, GithubPublishOps, PullLifecycle} from './githubPublish'
import {listAllRepos} from './repoRegistry'
import {loadScopeManifest} from './scope'
import {parseServiceNoticePlan} from './serviceNoticePlan'
import {
  NoticePublishContractResult,
  NoticePublishResult,
  NoticePublishTargetResult,
  PublishSyncContractResult,
  PublishSyncResult,
  PublishSyncTargetResult,
  RepoRecord,
} from './types'

interface BasePublishInput {
  db: Database.Database
  mapId: string
  sourceRepo: string
  contractChangeId?: string
  dryRun?: boolean
  cwd?: string
  githubToken?: string
  githubOps?: GithubPublishOps
}

export interface PublishNoticesInput extends BasePublishInput {
  maxTargets?: number
  ready?: boolean
  noticeType?: 'contract' | 'service'
  planPath?: string
}

export interface PublishSyncInput extends BasePublishInput {}

interface RepoParts {
  owner: string
  repo: string
  fullName: string
}

interface LoadedContractChange {
  row: ContractChangeIndexRow
  rowIndex: number
  doc?: ContractChangeDoc
  loadError?: string
  sourceChanged?: boolean
}

interface PublishContext {
  cwd: string
  scopeMapId: string
  scopedRepos: RepoRecord[]
  allRepos: RepoRecord[]
  sourceRepoParts: RepoParts
  sourceRepoPath: string
  indexMeta: ContractChangeIndexMeta
  indexRows: ContractChangeIndexRow[]
  ops?: GithubPublishOps
}

interface PublishTargetSuccess {
  prUrl: string
  created: boolean
  targetContractChangeId: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function today(): string {
  return nowIso().slice(0, 10)
}

function fileStamp(): string {
  return nowIso().replace(/[:.]/g, '-')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeRepoRef(value: string): string {
  const raw = value.trim()
  if (!raw) {
    return ''
  }

  const withoutProtocol = raw.replace(/^https?:\/\/github\.com\//i, '')
  return withoutProtocol.replace(/\.git$/i, '').replace(/\/+$/, '')
}

function repoParts(record: RepoRecord): RepoParts {
  const fullName = record.fullName.includes('/') ? record.fullName : `${record.org}/${record.name}`
  const [owner, repo] = fullName.split('/', 2)
  return {owner, repo, fullName}
}

function toContractSuffix(contractChangeId?: string): string {
  if (!contractChangeId) {
    return 'batch'
  }

  return slugify(contractChangeId) || 'single'
}

function createTargetBranch(contractChangeId: string, targetRepoName: string): string {
  return `sdx/spec-notice/${slugify(contractChangeId)}-${slugify(targetRepoName)}`.slice(0, 120)
}

function createSourceSyncBranch(contractChangeId: string): string {
  return `sdx/source-sync/${slugify(contractChangeId)}`.slice(0, 120)
}

function splitRepoOwnerAndName(value: string): {owner: string; repo: string} | null {
  const normalized = normalizeRepoRef(value)
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  return {
    owner: parts[0],
    repo: parts[1],
  }
}

function parseAliasTokens(raw: string): string[] {
  const value = raw.trim()
  if (!value) {
    return []
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry).trim()).filter(Boolean)
      }
    } catch {
      // Fall through to delimiter parsing.
    }
  }

  return value
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((entry) => entry.replace(/^"|"$/g, '').trim())
    .filter(Boolean)
}

function mergeAliasTokens(existing: string, additions: string[]): string {
  const merged = [...parseAliasTokens(existing), ...additions]
  const unique = [...new Set(merged)].sort((a, b) => a.localeCompare(b))
  return unique.join(', ')
}

function sourceAliasTokens(source: RepoParts, sourceContractId: string): string[] {
  return [`source_repo:${source.fullName}`, `source_cc:${sourceContractId}`]
}

function resolveRepoFromScope(
  inputRepo: string,
  ownerHint: string | undefined,
  scopedRepos: RepoRecord[],
  allRepos: RepoRecord[],
): {record?: RepoRecord; error?: string} {
  const normalized = normalizeRepoRef(inputRepo)
  if (!normalized) {
    return {error: 'Repository value is empty.'}
  }

  const fullMatch = splitRepoOwnerAndName(normalized)
  if (fullMatch) {
    const scoped = scopedRepos.filter((repo) => {
      const parts = repoParts(repo)
      return parts.owner.toLowerCase() === fullMatch.owner.toLowerCase() && parts.repo.toLowerCase() === fullMatch.repo.toLowerCase()
    })
    if (scoped.length === 1) {
      return {record: scoped[0]}
    }

    const allMatches = allRepos.filter((repo) => {
      const parts = repoParts(repo)
      return parts.owner.toLowerCase() === fullMatch.owner.toLowerCase() && parts.repo.toLowerCase() === fullMatch.repo.toLowerCase()
    })
    if (allMatches.length > 0) {
      return {error: `Repository '${normalized}' is outside the active map scope.`}
    }

    return {error: `Repository '${normalized}' was not found in the repo registry.`}
  }

  let matches = scopedRepos.filter((repo) => repo.name.toLowerCase() === normalized.toLowerCase())
  if (matches.length > 1 && ownerHint) {
    const ownerNormalized = ownerHint.trim().toLowerCase()
    const hinted = matches.filter((repo) => repoParts(repo).owner.toLowerCase() === ownerNormalized)
    if (hinted.length === 1) {
      matches = hinted
    }
  }

  if (matches.length === 1) {
    return {record: matches[0]}
  }

  if (matches.length > 1) {
    return {
      error: `Repository '${inputRepo}' is ambiguous in the current scope: ${matches
        .map((repo) => repoParts(repo).fullName)
        .join(', ')}`,
    }
  }

  const outOfScope = allRepos.some((repo) => repo.name.toLowerCase() === normalized.toLowerCase())
  if (outOfScope) {
    return {error: `Repository '${inputRepo}' is outside the active map scope.`}
  }

  return {error: `Repository '${inputRepo}' was not found in the repo registry.`}
}

function createPublishContext(input: BasePublishInput, requireOps: boolean): PublishContext {
  const cwd = input.cwd ?? process.cwd()
  const scope = loadScopeManifest(input.mapId, cwd)
  const allRepos = listAllRepos(input.db)
  const scopeSet = new Set(scope.effective)
  const scopedRepos = allRepos.filter((repo) => scopeSet.has(repo.name))

  const sourceResolution = resolveRepoFromScope(input.sourceRepo, undefined, scopedRepos, allRepos)
  if (!sourceResolution.record) {
    throw new Error(sourceResolution.error ?? `Unable to resolve source repo '${input.sourceRepo}'.`)
  }

  const sourceRepoRecord = sourceResolution.record
  if (!sourceRepoRecord.localPath) {
    throw new Error(
      `Source repository '${repoParts(sourceRepoRecord).fullName}' is missing local path metadata. Register it with 'sdx repo add --name ${sourceRepoRecord.name} --path <local-path>'.`,
    )
  }

  const indexPath = path.join(sourceRepoRecord.localPath, 'docs', 'CONTRACT_CHANGES.md')
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `Source repository '${repoParts(sourceRepoRecord).fullName}' is missing docs/CONTRACT_CHANGES.md. spec-system not instantiated (or invalid).`,
    )
  }

  const indexBody = fs.readFileSync(indexPath, 'utf8')
  if (!hasContractChangeIndexShape(indexBody)) {
    throw new Error(
      `Source repository '${repoParts(sourceRepoRecord).fullName}' has invalid docs/CONTRACT_CHANGES.md. spec-system not instantiated (or invalid).`,
    )
  }

  const {meta, rows} = parseContractChangeIndexText(indexBody)

  const ops = input.githubOps ?? (input.githubToken ? createGithubPublishOps(input.githubToken) : undefined)
  if (requireOps && !ops) {
    throw new Error('GitHub token is required for this command. Set GITHUB_TOKEN (or configured token env).')
  }

  return {
    cwd,
    scopeMapId: input.mapId,
    scopedRepos,
    allRepos,
    sourceRepoParts: repoParts(sourceRepoRecord),
    sourceRepoPath: sourceRepoRecord.localPath,
    indexMeta: meta,
    indexRows: rows,
    ops,
  }
}

function ensureArtifactPaths(baseDir: string, category: 'notices' | 'sync', mapId: string, contractChangeId?: string): {jsonPath: string; markdownPath: string} {
  const stamp = fileStamp()
  const suffix = toContractSuffix(contractChangeId)
  const jsonPath = path.join(baseDir, 'publish', category, `${stamp}-${slugify(mapId)}-${suffix}.json`)
  const markdownPath = path.join(baseDir, 'publish', category, `${stamp}-${slugify(mapId)}-${suffix}.md`)
  return {jsonPath, markdownPath}
}

function contractFilePath(contractChangeId: string, name: string): string {
  return `contracts/${contractChangeId}-${slugify(name) || slugify(contractChangeId)}.md`
}

function buildTargetContractDoc(
  source: RepoParts,
  sourceDoc: ContractChangeDoc,
  targetContractChangeId: string,
  targetOwner: string,
): ContractChangeDoc {
  return {
    contractChangeId: targetContractChangeId,
    name: `Respond to ${sourceDoc.contractChangeId}: ${sourceDoc.name}`,
    status: 'draft',
    changeType: sourceDoc.changeType || 'api_contract_changed',
    owner: targetOwner || sourceDoc.owner,
    lastUpdated: today(),
    absolutePath: '',
    relativePath: `docs/${contractFilePath(targetContractChangeId, sourceDoc.name)}`,
    sections: {
      summary: [
        `This contract change was generated by SDX from source contract change ${sourceDoc.contractChangeId}.`,
        '',
        `Source repository: ${source.fullName}`,
        '',
        sourceDoc.sections.summary.trim() || '_No summary provided._',
      ].join('\n'),
      contractSurface: sourceDoc.sections.contractSurface.trim() || '_No contract surface details provided._',
      changeDetails: [
        sourceDoc.sections.changeDetails.trim() || '_No change details provided._',
        '',
        `Source reference: ${source.fullName} / ${sourceDoc.contractChangeId}`,
      ].join('\n'),
      compatibilityAndMigrationGuidance:
        sourceDoc.sections.compatibilityAndMigrationGuidance.trim() || '_No migration guidance provided._',
    },
    targets: [],
  }
}

function buildTargetPrBody(
  source: RepoParts,
  sourceDoc: ContractChangeDoc,
  targetContext: string,
  targetContractChangeId: string,
): string {
  return [
    `## SDX Contract Change Assignment: ${targetContractChangeId}`,
    '',
    `Source repository: ${source.fullName}`,
    `Source contract change: ${sourceDoc.contractChangeId}`,
    `Change type: ${sourceDoc.changeType}`,
    '',
    '### Summary',
    sourceDoc.sections.summary.trim() || '_No summary provided._',
    '',
    '### Contract Surface',
    sourceDoc.sections.contractSurface.trim() || '_No contract surface details provided._',
    '',
    '### Migration Guidance',
    sourceDoc.sections.compatibilityAndMigrationGuidance.trim() || '_No migration guidance provided._',
    '',
    '### Target Context',
    targetContext,
    '',
    '### Required Response',
    '- [ ] Confirm impact on this repository.',
    '- [ ] Implement required code or contract adjustments.',
    '- [ ] Add tests and rollout notes.',
    '- [ ] Update CC status in this repo as work progresses.',
    '',
  ].join('\n')
}

function buildSourceSyncPrBody(doc: ContractChangeDoc): string {
  return [
    `## Source Sync for ${doc.contractChangeId}`,
    '',
    'This PR updates source contract change artifacts with downstream target PR links and states.',
    '',
    '### Updated Files',
    '- docs/CONTRACT_CHANGES.md',
    `- ${doc.relativePath}`,
    '',
  ].join('\n')
}

function updateIndexRowFromDoc(row: ContractChangeIndexRow, doc: ContractChangeDoc): void {
  row.status = doc.status
  row.name = doc.name
  row.changeType = doc.changeType
  row.owner = doc.owner
  if (!row.path.trim()) {
    row.path = doc.relativePath.replace(/^docs\//, '')
  }
}

function findIndexRowById(rows: ContractChangeIndexRow[], id: string): {row: ContractChangeIndexRow; rowIndex: number} | undefined {
  const rowIndex = rows.findIndex((row) => row.contractChangeId === id)
  if (rowIndex === -1) {
    return undefined
  }

  return {row: rows[rowIndex], rowIndex}
}

function findIndexRowByAlias(rows: ContractChangeIndexRow[], aliasToken: string): {row: ContractChangeIndexRow; rowIndex: number} | undefined {
  const rowIndex = rows.findIndex((row) => parseAliasTokens(row.aliases).includes(aliasToken))
  if (rowIndex === -1) {
    return undefined
  }

  return {row: rows[rowIndex], rowIndex}
}

function loadContractModeContracts(context: PublishContext, contractChangeId?: string): LoadedContractChange[] {
  const selectedRows = context.indexRows
    .map((row, rowIndex) => ({row, rowIndex}))
    .filter((entry) => (contractChangeId ? entry.row.contractChangeId === contractChangeId : true))
    .sort((a, b) => a.row.contractChangeId.localeCompare(b.row.contractChangeId))

  if (contractChangeId && selectedRows.length === 0) {
    throw new Error(`Contract change '${contractChangeId}' was not found in docs/CONTRACT_CHANGES.md.`)
  }

  return selectedRows.map((entry) => {
    try {
      const doc = readContractChangeDoc(context.sourceRepoPath, entry.row)
      return {row: entry.row, rowIndex: entry.rowIndex, doc, sourceChanged: false}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {row: entry.row, rowIndex: entry.rowIndex, loadError: message, sourceChanged: false}
    }
  })
}

function buildSourceDocFromServicePlan(context: PublishContext, input: PublishNoticesInput): LoadedContractChange {
  if (!input.planPath) {
    throw new Error('`--plan <file>` is required when --notice-type service is used.')
  }

  const planPath = path.resolve(context.cwd, input.planPath)
  if (!fs.existsSync(planPath)) {
    throw new Error(`Service plan file not found: ${planPath}`)
  }

  const planText = fs.readFileSync(planPath, 'utf8')
  const plan = parseServiceNoticePlan(planText)
  const serviceAlias = `service:${plan.serviceId}`

  let selected = input.contractChangeId
    ? findIndexRowById(context.indexRows, input.contractChangeId)
    : findIndexRowByAlias(context.indexRows, serviceAlias)

  if (!selected && input.contractChangeId) {
    if (!/^CC-\d{3}$/.test(input.contractChangeId)) {
      throw new Error(`Invalid --contract-change-id '${input.contractChangeId}'. Expected format CC-###.`)
    }

    const newRow: ContractChangeIndexRow = {
      contractChangeId: input.contractChangeId,
      name: `${plan.name} onboarding`,
      status: 'approved',
      changeType: 'api_contract_added',
      owner: context.sourceRepoParts.owner,
      path: contractFilePath(input.contractChangeId, plan.name),
      aliases: serviceAlias,
    }

    context.indexRows.push(newRow)
    selected = {row: newRow, rowIndex: context.indexRows.length - 1}
  }

  if (!selected) {
    const sourceContractId = nextContractChangeId(context.indexRows)
    const newRow: ContractChangeIndexRow = {
      contractChangeId: sourceContractId,
      name: `${plan.name} onboarding`,
      status: 'approved',
      changeType: 'api_contract_added',
      owner: context.sourceRepoParts.owner,
      path: contractFilePath(sourceContractId, plan.name),
      aliases: serviceAlias,
    }
    context.indexRows.push(newRow)
    selected = {row: newRow, rowIndex: context.indexRows.length - 1}
  }

  const existingRow = selected.row
  const existingTargetsByRepo = new Map<string, ContractTargetRow>()

  try {
    const existingDoc = readContractChangeDoc(context.sourceRepoPath, existingRow)
    for (const target of existingDoc.targets) {
      existingTargetsByRepo.set(normalizeRepoRef(target.repo), target)
    }
  } catch {
    // No existing source doc yet.
  }

  const nextTargets: ContractTargetRow[] = plan.targets.map((target) => {
    const preserved = existingTargetsByRepo.get(normalizeRepoRef(target.repo))
    return {
      repo: target.repo,
      owner: target.owner,
      context: target.context,
      prUrl: preserved?.prUrl ?? '',
      state: preserved?.state ?? 'pending',
    }
  })

  existingRow.name = `${plan.name} onboarding`
  existingRow.changeType = 'api_contract_added'
  existingRow.owner = context.sourceRepoParts.owner
  existingRow.path = existingRow.path || contractFilePath(existingRow.contractChangeId, plan.name)
  existingRow.aliases = mergeAliasTokens(existingRow.aliases, [serviceAlias])
  existingRow.status = existingRow.status === 'draft' ? 'approved' : existingRow.status

  const doc: ContractChangeDoc = {
    contractChangeId: existingRow.contractChangeId,
    name: existingRow.name,
    status: existingRow.status,
    changeType: existingRow.changeType,
    owner: existingRow.owner,
    lastUpdated: today(),
    absolutePath: path.join(context.sourceRepoPath, 'docs', existingRow.path),
    relativePath: `docs/${existingRow.path}`,
    sections: {
      summary: plan.summary,
      contractSurface: plan.contractSurface,
      changeDetails: plan.changeDetails,
      compatibilityAndMigrationGuidance: plan.migrationGuidance,
    },
    targets: nextTargets,
  }

  return {
    row: existingRow,
    rowIndex: selected.rowIndex,
    doc,
    sourceChanged: true,
  }
}

function buildNoticeContracts(context: PublishContext, input: PublishNoticesInput): LoadedContractChange[] {
  if (input.noticeType === 'service') {
    return [buildSourceDocFromServicePlan(context, input)]
  }

  return loadContractModeContracts(context, input.contractChangeId)
}

async function upsertSourceSync(
  context: PublishContext,
  doc: ContractChangeDoc,
  ready: boolean,
): Promise<string> {
  if (!context.ops) {
    throw new Error('GitHub publish operations are not configured.')
  }

  const branch = createSourceSyncBranch(doc.contractChangeId)
  await context.ops.ensureBranch(context.sourceRepoParts.owner, context.sourceRepoParts.repo, branch)

  const sourceDocPath = doc.relativePath.startsWith('docs/') ? doc.relativePath : `docs/${doc.relativePath}`
  await context.ops.upsertTextFile(
    context.sourceRepoParts.owner,
    context.sourceRepoParts.repo,
    branch,
    sourceDocPath,
    renderContractChangeDoc(doc),
    `chore(sdx): sync ${doc.contractChangeId} downstream state`,
  )

  await context.ops.upsertTextFile(
    context.sourceRepoParts.owner,
    context.sourceRepoParts.repo,
    branch,
    'docs/CONTRACT_CHANGES.md',
    renderContractChangeIndex(context.indexRows, context.indexMeta),
    `chore(sdx): refresh contract index for ${doc.contractChangeId}`,
  )

  const pr = await context.ops.upsertPullRequest({
    owner: context.sourceRepoParts.owner,
    repo: context.sourceRepoParts.repo,
    branch,
    title: `chore(sdx): sync ${doc.contractChangeId} downstream state`,
    body: buildSourceSyncPrBody(doc),
    draft: !ready,
  })

  return pr.url
}

function findExistingTargetRow(rows: ContractChangeIndexRow[], source: RepoParts, sourceDoc: ContractChangeDoc): ContractChangeIndexRow | undefined {
  const markers = sourceAliasTokens(source, sourceDoc.contractChangeId)
  return rows.find((row) => {
    const aliases = parseAliasTokens(row.aliases)
    return markers.every((marker) => aliases.includes(marker))
  })
}

async function publishTargetContractChange(
  context: PublishContext,
  sourceDoc: ContractChangeDoc,
  target: ContractTargetRow,
  targetRepo: RepoParts,
  ready: boolean,
): Promise<PublishTargetSuccess> {
  if (!context.ops) {
    throw new Error('GitHub publish operations are not configured.')
  }

  const branch = createTargetBranch(sourceDoc.contractChangeId, targetRepo.repo)
  await context.ops.ensureBranch(targetRepo.owner, targetRepo.repo, branch)

  const indexPath = 'docs/CONTRACT_CHANGES.md'
  const indexBody = await context.ops.readTextFile(targetRepo.owner, targetRepo.repo, indexPath, branch)
  if (!indexBody || !hasContractChangeIndexShape(indexBody)) {
    throw new Error('spec-system not instantiated (or invalid): missing or invalid docs/CONTRACT_CHANGES.md')
  }

  const parsed = parseContractChangeIndexText(indexBody)
  const existingTargetRow = findExistingTargetRow(parsed.rows, context.sourceRepoParts, sourceDoc)
  const targetContractChangeId = existingTargetRow
    ? existingTargetRow.contractChangeId
    : nextContractChangeId(parsed.rows)

  const sourceAliases = sourceAliasTokens(context.sourceRepoParts, sourceDoc.contractChangeId)
  const targetRow: ContractChangeIndexRow = {
    contractChangeId: targetContractChangeId,
    name: `Respond to ${sourceDoc.contractChangeId}: ${sourceDoc.name}`,
    status: 'draft',
    changeType: sourceDoc.changeType || 'api_contract_changed',
    owner: target.owner,
    path: existingTargetRow?.path || contractFilePath(targetContractChangeId, sourceDoc.name),
    aliases: mergeAliasTokens(existingTargetRow?.aliases ?? '', sourceAliases),
  }

  const rowIndex = parsed.rows.findIndex((row) => row.contractChangeId === targetRow.contractChangeId)
  if (rowIndex === -1) {
    parsed.rows.push(targetRow)
  } else {
    parsed.rows[rowIndex] = targetRow
  }

  parsed.rows.sort((a, b) => a.contractChangeId.localeCompare(b.contractChangeId))

  const targetDoc = buildTargetContractDoc(context.sourceRepoParts, sourceDoc, targetContractChangeId, target.owner)
  const targetDocPath = `docs/${targetRow.path.replace(/^docs\//, '')}`

  await context.ops.upsertTextFile(
    targetRepo.owner,
    targetRepo.repo,
    branch,
    indexPath,
    renderContractChangeIndex(parsed.rows, parsed.meta),
    `chore(sdx): register ${targetContractChangeId} from ${sourceDoc.contractChangeId}`,
  )

  await context.ops.upsertTextFile(
    targetRepo.owner,
    targetRepo.repo,
    branch,
    targetDocPath,
    renderContractChangeDoc(targetDoc),
    `chore(sdx): add ${targetContractChangeId} from ${sourceDoc.contractChangeId}`,
  )

  const pr = await context.ops.upsertPullRequest({
    owner: targetRepo.owner,
    repo: targetRepo.repo,
    branch,
    title: `chore(contract-change): ${targetContractChangeId} for ${sourceDoc.contractChangeId}`,
    body: buildTargetPrBody(context.sourceRepoParts, sourceDoc, target.context, targetContractChangeId),
    draft: !ready,
  })

  return {
    prUrl: pr.url,
    created: pr.created,
    targetContractChangeId,
  }
}

function buildNoticesArtifactMarkdown(result: NoticePublishResult): string {
  const lines: string[] = [
    '# Publish Notices Run',
    '',
    `- Generated: ${result.generatedAt}`,
    `- Map: ${result.mapId}`,
    `- Source Repo: ${result.sourceRepo}`,
    `- Notice Type: ${result.noticeType}`,
    `- Dry Run: ${result.dryRun ? 'yes' : 'no'}`,
    `- Draft Mode: ${result.ready ? 'ready PRs' : 'draft PRs'}`,
    ...(result.planPath ? [`- Plan Path: ${result.planPath}`] : []),
    ...(result.failFastStoppedAt ? [`- Fail Fast Stop: ${result.failFastStoppedAt}`] : []),
    '',
    `Totals: created=${result.totals.created}, updated=${result.totals.updated}, skipped=${result.totals.skipped}, failed=${result.totals.failed}`,
    '',
  ]

  for (const contract of result.contracts) {
    lines.push(`## ${contract.contractChangeId}: ${contract.name}`)
    lines.push(`- Eligible: ${contract.eligible ? 'yes' : 'no'}`)
    lines.push(`- Status: ${contract.sourceStatusBefore} -> ${contract.sourceStatusAfter}`)
    lines.push(`- Source Sync PR: ${contract.sourceSyncPrUrl ?? '-'}`)
    lines.push('')
    lines.push('| Target | Target CC | Result | State | PR | Notes |')
    lines.push('|---|---|---|---|---|---|')

    if (contract.targetResults.length === 0) {
      lines.push('| - | - | skipped | - | - | No target rows processed |')
    } else {
      for (const target of contract.targetResults) {
        lines.push(
          `| ${target.targetRepoInput} | ${target.targetContractChangeId ?? '-'} | ${target.status} | ${target.stateBefore} -> ${target.stateAfter} | ${target.prUrl ?? '-'} | ${target.reason ?? '-'} |`,
        )
      }
    }

    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function buildSyncArtifactMarkdown(result: PublishSyncResult): string {
  const lines: string[] = [
    '# Publish Sync Run',
    '',
    `- Generated: ${result.generatedAt}`,
    `- Map: ${result.mapId}`,
    `- Source Repo: ${result.sourceRepo}`,
    `- Dry Run: ${result.dryRun ? 'yes' : 'no'}`,
    '',
    `Totals: updated=${result.totals.updated}, skipped=${result.totals.skipped}, failed=${result.totals.failed}`,
    '',
  ]

  for (const contract of result.contracts) {
    lines.push(`## ${contract.contractChangeId}: ${contract.name}`)
    lines.push(`- Status: ${contract.sourceStatusBefore} -> ${contract.sourceStatusAfter}`)
    lines.push(`- Source Sync PR: ${contract.sourceSyncPrUrl ?? '-'}`)
    lines.push('')
    lines.push('| Target | Result | State | PR | Notes |')
    lines.push('|---|---|---|---|---|')

    if (contract.targetResults.length === 0) {
      lines.push('| - | skipped | - | - | No target rows processed |')
    } else {
      for (const target of contract.targetResults) {
        lines.push(
          `| ${target.repo} | ${target.status} | ${target.stateBefore} -> ${target.stateAfter} | ${target.prUrl || '-'} | ${target.reason ?? '-'} |`,
        )
      }
    }

    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function totalsForNotice(result: NoticePublishResult['contracts']): NoticePublishResult['totals'] {
  const totals = {created: 0, updated: 0, skipped: 0, failed: 0}
  for (const contract of result) {
    for (const target of contract.targetResults) {
      totals[target.status] += 1
    }
  }

  return totals
}

function totalsForSync(result: PublishSyncResult['contracts']): PublishSyncResult['totals'] {
  const totals = {updated: 0, skipped: 0, failed: 0}
  for (const contract of result) {
    for (const target of contract.targetResults) {
      totals[target.status] += 1
    }
  }

  return totals
}

function lifecycleToTargetState(value: PullLifecycle): 'opened' | 'merged' | 'blocked' {
  if (value === 'merged') {
    return 'merged'
  }

  if (value === 'blocked') {
    return 'blocked'
  }

  return 'opened'
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export async function publishNotices(input: PublishNoticesInput): Promise<NoticePublishResult> {
  const noticeType = input.noticeType ?? 'contract'
  const dryRun = Boolean(input.dryRun)
  const ready = Boolean(input.ready)
  const maxTargets = input.maxTargets && input.maxTargets > 0 ? input.maxTargets : undefined
  const context = createPublishContext(input, !dryRun)
  const sourceSyncPrUrls = new Set<string>()
  let remainingTargets = maxTargets ?? Number.POSITIVE_INFINITY
  let stopReason: string | undefined

  const contractsToProcess = buildNoticeContracts(context, input)
  const contracts: NoticePublishContractResult[] = []

  for (const loaded of contractsToProcess) {
    const fallbackName = loaded.row.name
    if (!loaded.doc) {
      contracts.push({
        contractChangeId: loaded.row.contractChangeId,
        name: fallbackName,
        sourceStatusBefore: loaded.row.status,
        sourceStatusAfter: loaded.row.status,
        eligible: false,
        targetResults: [
          {
            contractChangeId: loaded.row.contractChangeId,
            targetRepoInput: '-',
            owner: '-',
            stateBefore: '-',
            stateAfter: '-',
            status: 'failed',
            reason: loaded.loadError ?? 'Unable to load source contract change artifact.',
          },
        ],
      })
      stopReason = contracts[contracts.length - 1].targetResults[0].reason
      break
    }

    const doc = loaded.doc
    const contractResult: NoticePublishContractResult = {
      contractChangeId: doc.contractChangeId,
      name: doc.name,
      sourceStatusBefore: doc.status,
      sourceStatusAfter: doc.status,
      eligible: isNotifiableContractStatus(doc.status),
      targetResults: [],
    }

    if (!contractResult.eligible) {
      contractResult.targetResults.push({
        contractChangeId: doc.contractChangeId,
        targetRepoInput: '-',
        owner: '-',
        stateBefore: '-',
        stateAfter: '-',
        status: 'skipped',
        reason: `Status '${doc.status}' is not eligible. Expected approved or published.`,
      })
      contracts.push(contractResult)
      continue
    }

    for (const target of doc.targets) {
      const targetResult: NoticePublishTargetResult = {
        contractChangeId: doc.contractChangeId,
        targetRepoInput: target.repo,
        owner: target.owner,
        stateBefore: target.state,
        stateAfter: target.state,
        status: 'skipped',
      }

      if (target.state !== 'pending') {
        targetResult.reason = `Target state is '${target.state}', only pending targets are publishable.`
        contractResult.targetResults.push(targetResult)
        continue
      }

      if (!hasRequiredTargetContext(target)) {
        targetResult.status = 'failed'
        targetResult.reason = 'Target row is missing required repo/owner/context values.'
        contractResult.targetResults.push(targetResult)
        stopReason = targetResult.reason
        break
      }

      if (remainingTargets <= 0) {
        targetResult.reason = `Skipped due to --max-targets=${maxTargets}.`
        contractResult.targetResults.push(targetResult)
        continue
      }

      const resolution = resolveRepoFromScope(target.repo, target.owner, context.scopedRepos, context.allRepos)
      if (!resolution.record) {
        targetResult.status = 'failed'
        targetResult.reason = resolution.error
        contractResult.targetResults.push(targetResult)
        stopReason = targetResult.reason
        break
      }

      const targetRepo = repoParts(resolution.record)
      targetResult.targetRepoResolved = targetRepo.fullName

      if (dryRun) {
        targetResult.reason = 'Dry run: would create/update target spec-system contract change PR.'
        contractResult.targetResults.push(targetResult)
        remainingTargets -= 1
        continue
      }

      try {
        const published = await publishTargetContractChange(context, doc, target, targetRepo, ready)
        target.prUrl = published.prUrl
        target.state = 'opened'
        targetResult.stateAfter = 'opened'
        targetResult.prUrl = published.prUrl
        targetResult.targetContractChangeId = published.targetContractChangeId
        targetResult.status = published.created ? 'created' : 'updated'
        loaded.sourceChanged = true
      } catch (error) {
        targetResult.status = 'failed'
        targetResult.reason = formatError(error)
        stopReason = targetResult.reason
      }

      contractResult.targetResults.push(targetResult)
      remainingTargets -= 1

      if (targetResult.status === 'failed') {
        break
      }
    }

    doc.status = computeContractChangeStatus(doc.status, doc.targets)
    contractResult.sourceStatusAfter = doc.status
    updateIndexRowFromDoc(loaded.row, doc)

    if (!dryRun && loaded.sourceChanged) {
      try {
        const sourceSyncPrUrl = await upsertSourceSync(context, doc, ready)
        contractResult.sourceSyncPrUrl = sourceSyncPrUrl
        sourceSyncPrUrls.add(sourceSyncPrUrl)
      } catch (error) {
        const syncFailure: NoticePublishTargetResult = {
          contractChangeId: doc.contractChangeId,
          targetRepoInput: context.sourceRepoParts.fullName,
          owner: context.sourceRepoParts.owner,
          stateBefore: contractResult.sourceStatusBefore,
          stateAfter: contractResult.sourceStatusAfter,
          status: 'failed',
          reason: `Source sync failed: ${formatError(error)}`,
        }
        contractResult.targetResults.push(syncFailure)
        stopReason = syncFailure.reason
      }
    }

    contracts.push(contractResult)

    if (stopReason) {
      break
    }
  }

  const artifactPaths = ensureArtifactPaths(context.cwd, 'notices', input.mapId, input.contractChangeId)
  const result: NoticePublishResult = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    mapId: input.mapId,
    sourceRepo: context.sourceRepoParts.fullName,
    contractChangeId: input.contractChangeId,
    noticeType,
    planPath: input.planPath ? path.resolve(context.cwd, input.planPath) : undefined,
    dryRun,
    ready,
    maxTargets,
    failFastStoppedAt: stopReason,
    totals: totalsForNotice(contracts),
    contracts,
    sourceSyncPrUrls: [...sourceSyncPrUrls].sort((a, b) => a.localeCompare(b)),
    artifactJsonPath: artifactPaths.jsonPath,
    artifactMarkdownPath: artifactPaths.markdownPath,
  }

  writeJsonFile(result.artifactJsonPath, result)
  writeTextFile(result.artifactMarkdownPath, buildNoticesArtifactMarkdown(result))
  return result
}

export async function publishSync(input: PublishSyncInput): Promise<PublishSyncResult> {
  const dryRun = Boolean(input.dryRun)
  const context = createPublishContext(input, !dryRun)
  const sourceSyncPrUrls = new Set<string>()

  const contractsToProcess = loadContractModeContracts(context, input.contractChangeId)
  const contracts: PublishSyncContractResult[] = []

  for (const loaded of contractsToProcess) {
    if (!loaded.doc) {
      contracts.push({
        contractChangeId: loaded.row.contractChangeId,
        name: loaded.row.name,
        sourceStatusBefore: loaded.row.status,
        sourceStatusAfter: loaded.row.status,
        targetResults: [
          {
            contractChangeId: loaded.row.contractChangeId,
            repo: '-',
            prUrl: '',
            stateBefore: '-',
            stateAfter: '-',
            status: 'failed',
            reason: loaded.loadError ?? 'Unable to load source contract change artifact.',
          },
        ],
      })
      continue
    }

    const doc = loaded.doc
    const contractResult: PublishSyncContractResult = {
      contractChangeId: doc.contractChangeId,
      name: doc.name,
      sourceStatusBefore: doc.status,
      sourceStatusAfter: doc.status,
      targetResults: [],
    }

    for (const target of doc.targets) {
      const targetResult: PublishSyncTargetResult = {
        contractChangeId: doc.contractChangeId,
        repo: target.repo,
        prUrl: target.prUrl,
        stateBefore: target.state,
        stateAfter: target.state,
        status: 'skipped',
      }

      if (!target.prUrl.trim()) {
        targetResult.reason = 'No pr_url set.'
        contractResult.targetResults.push(targetResult)
        continue
      }

      if (dryRun) {
        targetResult.reason = 'Dry run: would refresh PR lifecycle state.'
        contractResult.targetResults.push(targetResult)
        continue
      }

      if (!context.ops) {
        targetResult.status = 'failed'
        targetResult.reason = 'GitHub token not available; cannot refresh PR lifecycle.'
        contractResult.targetResults.push(targetResult)
        continue
      }

      try {
        const lifecycle = await context.ops.getPullLifecycle(target.prUrl)
        const nextState = lifecycleToTargetState(lifecycle)
        target.state = nextState
        targetResult.stateAfter = nextState
        targetResult.status = nextState === targetResult.stateBefore ? 'skipped' : 'updated'
        if (targetResult.status === 'skipped') {
          targetResult.reason = 'State unchanged after lifecycle lookup.'
        } else {
          loaded.sourceChanged = true
        }
      } catch (error) {
        targetResult.status = 'failed'
        targetResult.reason = formatError(error)
      }

      contractResult.targetResults.push(targetResult)
    }

    doc.status = computeContractChangeStatus(doc.status, doc.targets)
    contractResult.sourceStatusAfter = doc.status
    updateIndexRowFromDoc(loaded.row, doc)

    if (!dryRun && loaded.sourceChanged) {
      try {
        const sourceSyncPrUrl = await upsertSourceSync(context, doc, false)
        contractResult.sourceSyncPrUrl = sourceSyncPrUrl
        sourceSyncPrUrls.add(sourceSyncPrUrl)
      } catch (error) {
        contractResult.targetResults.push({
          contractChangeId: doc.contractChangeId,
          repo: context.sourceRepoParts.fullName,
          prUrl: '',
          stateBefore: contractResult.sourceStatusBefore,
          stateAfter: contractResult.sourceStatusAfter,
          status: 'failed',
          reason: `Source sync failed: ${formatError(error)}`,
        })
      }
    }

    contracts.push(contractResult)
  }

  const artifactPaths = ensureArtifactPaths(context.cwd, 'sync', input.mapId, input.contractChangeId)
  const result: PublishSyncResult = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(),
    mapId: input.mapId,
    sourceRepo: context.sourceRepoParts.fullName,
    contractChangeId: input.contractChangeId,
    dryRun,
    totals: totalsForSync(contracts),
    contracts,
    sourceSyncPrUrls: [...sourceSyncPrUrls].sort((a, b) => a.localeCompare(b)),
    artifactJsonPath: artifactPaths.jsonPath,
    artifactMarkdownPath: artifactPaths.markdownPath,
  }

  writeJsonFile(result.artifactJsonPath, result)
  writeTextFile(result.artifactMarkdownPath, buildSyncArtifactMarkdown(result))
  return result
}
