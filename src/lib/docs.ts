import {ContractRecord, ScopeManifest, ServiceMapArtifact} from './types'

export function renderArchitectureDoc(
  mapId: string,
  scope: ScopeManifest,
  serviceMap: ServiceMapArtifact,
  contracts: ContractRecord[],
): string {
  const missingLocal = serviceMap.nodes
    .filter((node) => node.type === 'repo')
    .filter((node) => !node.metadata?.['localPath'])
    .map((node) => node.label)

  const lines = [
    `# Architecture Overview: ${mapId}`,
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Org: ${scope.org}`,
    `- Effective repositories: ${scope.effective.length}`,
    `- Contracts discovered: ${contracts.length}`,
    `- Services mapped: ${serviceMap.nodes.filter((node) => node.type === 'service').length}`,
    '',
    '## System Design Coverage',
    '',
    ...serviceMap.coverageTags.map((tag) => `- ${tag}`),
    '',
    '## Repository Scope',
    '',
    ...scope.effective.map((repo) => `- ${repo}`),
    '',
    '## Integration Signals',
    '',
    ...serviceMap.edges.slice(0, 50).map((edge) => `- ${edge.from} ${edge.relation} ${edge.to}`),
    '',
    '## Contract Surface',
    '',
    ...contracts.slice(0, 100).map((contract) => `- ${contract.repo}: ${contract.type} ${contract.path}`),
    '',
  ]

  if (missingLocal.length > 0) {
    lines.push('## Partial Visibility')
    lines.push('')
    lines.push('The following repositories are in scope but do not have registered local paths:')
    lines.push('')
    for (const repo of missingLocal) {
      lines.push(`- ${repo}`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
