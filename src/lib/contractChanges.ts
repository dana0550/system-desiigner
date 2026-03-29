import fs from 'node:fs'
import path from 'node:path'

export type ContractChangeStatus = 'draft' | 'approved' | 'published' | 'closed'
export type ContractTargetState = 'pending' | 'opened' | 'merged' | 'blocked'

export interface ContractChangeIndexMeta {
  docType?: string
  version?: string
}

export interface ContractChangeIndexRow {
  contractChangeId: string
  name: string
  status: ContractChangeStatus
  changeType: string
  owner: string
  path: string
  aliases: string
}

export interface ContractTargetRow {
  repo: string
  owner: string
  context: string
  prUrl: string
  state: ContractTargetState
}

export interface ContractChangeDoc {
  contractChangeId: string
  name: string
  status: ContractChangeStatus
  changeType: string
  owner: string
  lastUpdated: string
  absolutePath: string
  relativePath: string
  sections: {
    summary: string
    contractSurface: string
    changeDetails: string
    compatibilityAndMigrationGuidance: string
  }
  targets: ContractTargetRow[]
}

const CONTRACT_TABLE_HEADER = '| ID | Name | Status | Change Type | Owner | Path | Aliases |'
const CONTRACT_TABLE_RULE = '|----|------|--------|-------------|-------|------|---------|'
const TARGET_TABLE_HEADER = '| repo | owner | context | pr_url | state |'
const TARGET_TABLE_RULE = '|------|-------|---------|--------|-------|'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function normalizeCell(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function splitMarkdownTableRow(value: string): string[] {
  return value
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((part) => normalizeCell(part))
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|')
}

function normalizeStatus(value: string): ContractChangeStatus {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'draft' || normalized === 'approved' || normalized === 'published' || normalized === 'closed') {
    return normalized
  }

  return 'draft'
}

function normalizeTargetState(value: string): ContractTargetState {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'pending' || normalized === 'opened' || normalized === 'merged' || normalized === 'blocked') {
    return normalized
  }

  return 'pending'
}

function parseFrontmatter(text: string): {frontmatter: Record<string, string>; body: string} {
  if (!text.startsWith('---\n')) {
    return {frontmatter: {}, body: text}
  }

  const end = text.indexOf('\n---\n', 4)
  if (end === -1) {
    return {frontmatter: {}, body: text}
  }

  const block = text.slice(4, end)
  const body = text.slice(end + 5)
  const frontmatter: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) {
      continue
    }

    const key = line.slice(0, idx).trim()
    const value = normalizeCell(line.slice(idx + 1).trim())
    if (key) {
      frontmatter[key] = value
    }
  }

  return {frontmatter, body}
}

export function hasContractChangeIndexShape(text: string): boolean {
  return (
    text.includes('doc_type: contract_change_index') &&
    text.includes(CONTRACT_TABLE_HEADER) &&
    text.includes(CONTRACT_TABLE_RULE)
  )
}

function parseSections(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  const sections: Record<string, string> = {}
  let current = ''
  let buffer: string[] = []

  const flush = (): void => {
    if (!current) {
      return
    }

    sections[current] = buffer.join('\n').trim()
    buffer = []
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      flush()
      current = heading[1].trim()
      continue
    }

    if (current) {
      buffer.push(line)
    }
  }

  flush()
  return sections
}

function parseTargetsFromSection(sectionBody: string): ContractTargetRow[] {
  const tableLines = sectionBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))

  if (tableLines.length < 2) {
    return []
  }

  const header = splitMarkdownTableRow(tableLines[0]).map((cell) => cell.toLowerCase())
  const required = ['repo', 'owner', 'context', 'pr_url', 'state']
  if (required.some((col) => !header.includes(col))) {
    return []
  }

  const targets: ContractTargetRow[] = []
  for (const line of tableLines.slice(2)) {
    const cells = splitMarkdownTableRow(line)
    const row: Record<string, string> = {}
    for (let i = 0; i < header.length; i += 1) {
      row[header[i]] = (cells[i] ?? '').trim()
    }

    const target: ContractTargetRow = {
      repo: row.repo ?? '',
      owner: row.owner ?? '',
      context: row.context ?? '',
      prUrl: row.pr_url ?? '',
      state: normalizeTargetState(row.state ?? ''),
    }

    const hasData = Object.values(target).some((value) => value.trim().length > 0)
    if (hasData) {
      targets.push(target)
    }
  }

  return targets
}

function renderTargetTable(targets: ContractTargetRow[]): string {
  const lines = [TARGET_TABLE_HEADER, TARGET_TABLE_RULE]
  for (const target of targets) {
    lines.push(
      `| ${escapeCell(target.repo)} | ${escapeCell(target.owner)} | ${escapeCell(target.context)} | ${escapeCell(target.prUrl)} | ${escapeCell(target.state)} |`,
    )
  }

  lines.push('')
  return lines.join('\n')
}

function toPosix(value: string): string {
  return value.replaceAll('\\\\', '/').replaceAll('\\', '/')
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))]
}

function buildContractDocCandidates(contractChangeId: string, rowPath: string): string[] {
  const normalizedPath = toPosix(rowPath.trim())
  const basename = path.posix.basename(normalizedPath || `${contractChangeId}.md`)

  return unique([
    normalizedPath,
    normalizedPath.startsWith('docs/') ? normalizedPath : `docs/${normalizedPath}`,
    `docs/contracts/${basename}`,
    `docs/contracts/${contractChangeId}.md`,
  ])
}

export function resolveContractDocRepoPath(contractChangeId: string, rowPath: string): string {
  const candidates = buildContractDocCandidates(contractChangeId, rowPath)
  for (const candidate of candidates) {
    if (candidate && !candidate.startsWith('/') && candidate.startsWith('docs/')) {
      return candidate
    }
  }

  for (const candidate of candidates) {
    if (candidate && !candidate.startsWith('/')) {
      return candidate
    }
  }

  return `docs/contracts/${contractChangeId}.md`
}

export function resolveContractDocAbsolutePath(sourceRepoPath: string, contractChangeId: string, rowPath: string): string {
  const candidates = buildContractDocCandidates(contractChangeId, rowPath)
  for (const repoPath of candidates) {
    const absolutePath = path.join(sourceRepoPath, repoPath)
    if (fs.existsSync(absolutePath)) {
      return absolutePath
    }
  }

  return path.join(sourceRepoPath, resolveContractDocRepoPath(contractChangeId, rowPath))
}

export function readContractChangeIndex(indexPath: string): {meta: ContractChangeIndexMeta; rows: ContractChangeIndexRow[]} {
  if (!fs.existsSync(indexPath)) {
    return {meta: {}, rows: []}
  }

  const text = fs.readFileSync(indexPath, 'utf8')
  return parseContractChangeIndexText(text)
}

export function parseContractChangeIndexText(text: string): {meta: ContractChangeIndexMeta; rows: ContractChangeIndexRow[]} {
  const {frontmatter, body} = parseFrontmatter(text)
  const rows: ContractChangeIndexRow[] = []

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      continue
    }

    if (trimmed === CONTRACT_TABLE_HEADER || trimmed === CONTRACT_TABLE_RULE) {
      continue
    }

    const parts = splitMarkdownTableRow(trimmed)
    if (parts.length < 7 || !parts[0].startsWith('CC-')) {
      continue
    }

    rows.push({
      contractChangeId: parts[0],
      name: parts[1],
      status: normalizeStatus(parts[2]),
      changeType: parts[3],
      owner: parts[4],
      path: parts[5],
      aliases: parts[6],
    })
  }

  return {
    meta: {
      docType: frontmatter.doc_type,
      version: frontmatter.version,
    },
    rows,
  }
}

export function nextContractChangeId(rows: ContractChangeIndexRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = row.contractChangeId.match(/^CC-(\d{3})$/)
    if (!match) {
      continue
    }

    const value = Number(match[1])
    if (value > max) {
      max = value
    }
  }

  const next = max + 1
  return `CC-${String(next).padStart(3, '0')}`
}

export function renderContractChangeIndex(rows: ContractChangeIndexRow[], meta: ContractChangeIndexMeta): string {
  const sorted = [...rows].sort((a, b) => a.contractChangeId.localeCompare(b.contractChangeId))
  const lines: string[] = [
    '---',
    `doc_type: ${meta.docType ?? 'contract_change_index'}`,
    `version: ${meta.version ?? '2.4.0'}`,
    `last_synced: ${today()}`,
    '---',
    '# Contract Changes Index',
    '',
    CONTRACT_TABLE_HEADER,
    CONTRACT_TABLE_RULE,
  ]

  for (const row of sorted) {
    lines.push(
      `| ${escapeCell(row.contractChangeId)} | ${escapeCell(row.name)} | ${escapeCell(row.status)} | ${escapeCell(row.changeType)} | ${escapeCell(row.owner)} | ${escapeCell(row.path)} | ${escapeCell(row.aliases)} |`,
    )
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

export function writeContractChangeIndex(indexPath: string, rows: ContractChangeIndexRow[], meta: ContractChangeIndexMeta): void {
  fs.writeFileSync(indexPath, renderContractChangeIndex(rows, meta), 'utf8')
}

export function readContractChangeDoc(sourceRepoPath: string, row: ContractChangeIndexRow): ContractChangeDoc {
  const absolutePath = resolveContractDocAbsolutePath(sourceRepoPath, row.contractChangeId, row.path)
  const text = fs.readFileSync(absolutePath, 'utf8')
  const {frontmatter, body} = parseFrontmatter(text)
  const sections = parseSections(body)
  const targets = parseTargetsFromSection(sections['Downstream Notification Context'] ?? '')
  const relativeFromRoot = toPosix(path.relative(sourceRepoPath, absolutePath))

  return {
    contractChangeId: frontmatter.contract_change_id ?? row.contractChangeId,
    name: frontmatter.name ?? row.name,
    status: normalizeStatus(frontmatter.status ?? row.status),
    changeType: frontmatter.change_type ?? row.changeType,
    owner: frontmatter.owner ?? row.owner,
    lastUpdated: frontmatter.last_updated ?? today(),
    absolutePath,
    relativePath: relativeFromRoot || resolveContractDocRepoPath(row.contractChangeId, row.path),
    sections: {
      summary: sections.Summary ?? '',
      contractSurface: sections['Contract Surface'] ?? '',
      changeDetails: sections['Change Details'] ?? '',
      compatibilityAndMigrationGuidance: sections['Compatibility and Migration Guidance'] ?? '',
    },
    targets,
  }
}

export function renderContractChangeDoc(doc: ContractChangeDoc): string {
  const blocks = [
    '---',
    'doc_type: contract_change',
    `contract_change_id: ${doc.contractChangeId}`,
    `name: ${doc.name}`,
    `status: ${doc.status}`,
    `change_type: ${doc.changeType}`,
    `owner: ${doc.owner}`,
    `last_updated: ${doc.lastUpdated || today()}`,
    '---',
    `# ${doc.name}`,
    '',
    '## Summary',
    doc.sections.summary.trim(),
    '',
    '## Contract Surface',
    doc.sections.contractSurface.trim(),
    '',
    '## Change Details',
    doc.sections.changeDetails.trim(),
    '',
    '## Compatibility and Migration Guidance',
    doc.sections.compatibilityAndMigrationGuidance.trim(),
    '',
    '## Downstream Notification Context',
    renderTargetTable(doc.targets).trimEnd(),
    '',
  ]

  return `${blocks.join('\n')}\n`
}

export function isNotifiableContractStatus(status: ContractChangeStatus): boolean {
  return status === 'approved' || status === 'published'
}

export function hasRequiredTargetContext(target: ContractTargetRow): boolean {
  return target.repo.trim().length > 0 && target.owner.trim().length > 0 && target.context.trim().length > 0
}

export function computeContractChangeStatus(current: ContractChangeStatus, targets: ContractTargetRow[]): ContractChangeStatus {
  if (targets.length === 0) {
    return current
  }

  if (targets.every((target) => target.state === 'merged')) {
    return 'closed'
  }

  if (targets.every((target) => target.state === 'opened' || target.state === 'merged')) {
    return 'published'
  }

  return current
}
