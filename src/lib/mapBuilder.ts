import fs from 'node:fs'
import path from 'node:path'
import {PRIMER_DIMENSIONS, SCHEMA_VERSION} from './constants'
import {listFilesRecursive} from './fileScan'
import {RepoRecord, ScopeManifest, ServiceEdge, ServiceMapArtifact, ServiceNode} from './types'

const CONTRACT_REGEX = [
  /openapi.*\.(ya?ml|json)$/i,
  /swagger\.(ya?ml|json)$/i,
  /asyncapi.*\.(ya?ml|json)$/i,
  /\.graphql$/i,
  /\.gql$/i,
  /\.proto$/i,
]

function classifyContract(filePath: string): 'api' | 'event' {
  const lower = filePath.toLowerCase()
  if (lower.includes('asyncapi') || lower.includes('event')) {
    return 'event'
  }

  return 'api'
}

function readPackageDependencies(repoPath: string): string[] {
  const packagePath = path.join(repoPath, 'package.json')
  if (!fs.existsSync(packagePath)) {
    return []
  }

  try {
    const data = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }

    const names = new Set<string>([
      ...Object.keys(data.dependencies ?? {}),
      ...Object.keys(data.devDependencies ?? {}),
      ...Object.keys(data.peerDependencies ?? {}),
    ])

    return [...names]
  } catch {
    return []
  }
}

function dedupeNodes(nodes: ServiceNode[]): ServiceNode[] {
  const seen = new Set<string>()
  const out: ServiceNode[] = []
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue
    }
    seen.add(node.id)
    out.push(node)
  }
  return out
}

function dedupeEdges(edges: ServiceEdge[]): ServiceEdge[] {
  const seen = new Set<string>()
  const out: ServiceEdge[] = []
  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}|${edge.relation}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(edge)
  }
  return out
}

export function buildServiceMapArtifact(
  mapId: string,
  scope: ScopeManifest,
  reposByName: Map<string, RepoRecord>,
): ServiceMapArtifact {
  const nodes: ServiceNode[] = []
  const edges: ServiceEdge[] = []
  const effectiveSet = new Set(scope.effective)

  for (const repoName of scope.effective) {
    const repo = reposByName.get(repoName)

    nodes.push({
      id: `service:${repoName}`,
      type: 'service',
      label: repoName,
      repo: repoName,
      metadata: {
        org: repo?.org ?? scope.org,
      },
    })

    nodes.push({
      id: `repo:${repoName}`,
      type: 'repo',
      label: repoName,
      repo: repoName,
      metadata: {
        source: repo?.source ?? 'github',
        localPath: repo?.localPath,
        htmlUrl: repo?.htmlUrl,
        defaultBranch: repo?.defaultBranch,
      },
    })

    edges.push({
      from: `service:${repoName}`,
      to: `repo:${repoName}`,
      relation: 'owns',
    })

    if (!repo?.localPath || !fs.existsSync(repo.localPath)) {
      continue
    }

    const deps = readPackageDependencies(repo.localPath)
    for (const dep of deps) {
      if (!effectiveSet.has(dep)) {
        continue
      }

      edges.push({
        from: `service:${repoName}`,
        to: `service:${dep}`,
        relation: 'depends_on',
      })
    }

    const allFiles = listFilesRecursive(repo.localPath)
    const contractFiles = allFiles.filter((candidate) => CONTRACT_REGEX.some((pattern) => pattern.test(candidate)))

    for (const contractPath of contractFiles) {
      const relPath = path.relative(repo.localPath, contractPath)
      const nodeType = classifyContract(relPath)
      const contractNodeId = `${nodeType}:${repoName}:${relPath}`
      nodes.push({
        id: contractNodeId,
        type: nodeType === 'event' ? 'event' : 'api',
        label: relPath,
        repo: repoName,
      })

      edges.push({
        from: `service:${repoName}`,
        to: contractNodeId,
        relation: nodeType === 'event' ? 'publishes' : 'calls',
      })
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    org: scope.org,
    repos: [...scope.effective],
    nodes: dedupeNodes(nodes),
    edges: dedupeEdges(edges),
    coverageTags: [...PRIMER_DIMENSIONS],
  }
}

export function renderServiceMapMermaid(artifact: ServiceMapArtifact): string {
  const lines: string[] = ['flowchart LR']

  for (const node of artifact.nodes) {
    const id = node.id.replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`  ${id}["${node.label}"]`)
  }

  for (const edge of artifact.edges) {
    const from = edge.from.replace(/[^a-zA-Z0-9_]/g, '_')
    const to = edge.to.replace(/[^a-zA-Z0-9_]/g, '_')
    lines.push(`  ${from} -->|"${edge.relation}"| ${to}`)
  }

  return `${lines.join('\n')}\n`
}

export function renderServiceMapMarkdown(artifact: ServiceMapArtifact): string {
  const lines = [
    `# Service Map: ${artifact.mapId}`,
    '',
    `- Generated: ${artifact.generatedAt}`,
    `- Org: ${artifact.org}`,
    `- Repos in scope: ${artifact.repos.length}`,
    `- Nodes: ${artifact.nodes.length}`,
    `- Edges: ${artifact.edges.length}`,
    '',
    '## Repositories',
    '',
    ...artifact.repos.map((repo) => `- ${repo}`),
    '',
    '## Top Relations',
    '',
    ...artifact.edges.slice(0, 30).map((edge) => `- ${edge.from} ${edge.relation} ${edge.to}`),
    '',
    '## Coverage Tags',
    '',
    ...artifact.coverageTags.map((tag) => `- ${tag}`),
    '',
  ]

  return `${lines.join('\n')}\n`
}
