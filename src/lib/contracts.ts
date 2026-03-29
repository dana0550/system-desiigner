import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {SCHEMA_VERSION} from './constants'
import {listFilesRecursive} from './fileScan'
import {ContractRecord, RepoRecord, ScopeManifest} from './types'

const PATTERNS: Array<{type: ContractRecord['type']; regex: RegExp}> = [
  {type: 'openapi', regex: /openapi.*\.(ya?ml|json)$/i},
  {type: 'openapi', regex: /swagger\.(ya?ml|json)$/i},
  {type: 'graphql', regex: /\.(graphql|gql)$/i},
  {type: 'proto', regex: /\.proto$/i},
  {type: 'asyncapi', regex: /asyncapi.*\.(ya?ml|json)$/i},
]

function detectType(filePath: string): ContractRecord['type'] | null {
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(filePath)) {
      return pattern.type
    }
  }

  return null
}

function tryExtractVersion(filePath: string): string | undefined {
  const lower = filePath.toLowerCase()
  if (!(lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml'))) {
    return undefined
  }

  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const data = lower.endsWith('.json') ? JSON.parse(text) : YAML.parse(text)
    if (typeof data?.info?.version === 'string') {
      return data.info.version
    }

    if (typeof data?.version === 'string') {
      return data.version
    }
  } catch {
    return undefined
  }

  return undefined
}

export function extractContracts(
  mapId: string,
  scope: ScopeManifest,
  reposByName: Map<string, RepoRecord>,
): ContractRecord[] {
  const out: ContractRecord[] = []

  for (const repoName of scope.effective) {
    const repo = reposByName.get(repoName)
    if (!repo?.localPath || !fs.existsSync(repo.localPath)) {
      continue
    }

    const files = listFilesRecursive(repo.localPath)
    for (const filePath of files) {
      const type = detectType(filePath)
      if (!type) {
        continue
      }

      const relPath = path.relative(repo.localPath, filePath)
      out.push({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        mapId,
        repo: repoName,
        type,
        path: relPath,
        version: tryExtractVersion(filePath),
        producers: [repoName],
        consumers: [],
        compatibilityStatus: 'unknown',
        sourcePointer: `${repo.fullName}:${relPath}`,
      })
    }
  }

  out.sort((a, b) => `${a.repo}:${a.path}`.localeCompare(`${b.repo}:${b.path}`))
  return out
}

export function renderContractsMarkdown(records: ContractRecord[], mapId: string): string {
  const lines = [
    `# Contracts: ${mapId}`,
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Total contracts: ${records.length}`,
    '',
    '| Repo | Type | Path | Version | Compatibility |',
    '|---|---|---|---|---|',
    ...records.map(
      (record) =>
        `| ${record.repo} | ${record.type} | ${record.path} | ${record.version ?? '-'} | ${record.compatibilityStatus} |`,
    ),
    '',
  ]

  return `${lines.join('\n')}\n`
}
