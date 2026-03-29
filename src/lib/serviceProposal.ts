import fs from 'node:fs'
import path from 'node:path'
import {PRIMER_DIMENSIONS} from './constants'
import {ContractRecord, ScopeManifest} from './types'

export interface ServiceProposalArtifact {
  schemaVersion: string
  generatedAt: string
  mapId: string
  briefPath: string
  proposedServiceName: string
  options: Array<{
    name: string
    summary: string
    tradeoffs: string[]
  }>
  integrationCandidates: string[]
  coverageTags: string[]
}

export function proposeService(
  mapId: string,
  briefPath: string,
  scope: ScopeManifest,
  contracts: ContractRecord[],
): ServiceProposalArtifact {
  const absolute = path.resolve(briefPath)
  const text = fs.readFileSync(absolute, 'utf8')
  const firstHeadingMatch = text.match(/^#\s+(.+)$/m)
  const proposedServiceName = firstHeadingMatch?.[1]?.trim() || path.basename(briefPath, path.extname(briefPath))

  const lower = text.toLowerCase()
  const integrationCandidates = scope.effective.filter((repo) => lower.includes(repo.toLowerCase()))

  const contractHeavyRepos = new Set(contracts.slice(0, 50).map((contract) => contract.repo))
  const likelyDependencies = integrationCandidates.filter((repo) => contractHeavyRepos.has(repo))

  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    mapId,
    briefPath: absolute,
    proposedServiceName,
    options: [
      {
        name: 'Option A: Isolated service with explicit contracts',
        summary: 'Create a standalone service with versioned API contracts and async event boundaries.',
        tradeoffs: [
          'Higher initial setup cost, cleaner ownership boundaries.',
          'Simpler rollback and blast-radius control.',
        ],
      },
      {
        name: 'Option B: Incremental extension of existing service surface',
        summary: 'Ship initial capability through an existing service boundary before splitting out.',
        tradeoffs: [
          'Faster initial delivery, but weaker long-term modularity.',
          'Requires careful migration and deprecation sequencing.',
        ],
      },
    ],
    integrationCandidates: likelyDependencies.length > 0 ? likelyDependencies : integrationCandidates,
    coverageTags: [...PRIMER_DIMENSIONS],
  }
}

export function renderServiceProposalMarkdown(proposal: ServiceProposalArtifact): string {
  const lines = [
    `# Service Proposal: ${proposal.proposedServiceName}`,
    '',
    `- Generated: ${proposal.generatedAt}`,
    `- Map: ${proposal.mapId}`,
    `- Brief: ${proposal.briefPath}`,
    '',
    '## Candidate Integration Repositories',
    '',
    ...(proposal.integrationCandidates.length > 0
      ? proposal.integrationCandidates.map((repo) => `- ${repo}`)
      : ['- none detected from brief text']),
    '',
    '## Architecture Options',
    '',
  ]

  for (const option of proposal.options) {
    lines.push(`### ${option.name}`)
    lines.push('')
    lines.push(option.summary)
    lines.push('')
    for (const tradeoff of option.tradeoffs) {
      lines.push(`- ${tradeoff}`)
    }
    lines.push('')
  }

  lines.push('## Coverage Tags')
  lines.push('')
  for (const tag of proposal.coverageTags) {
    lines.push(`- ${tag}`)
  }
  lines.push('')

  return `${lines.join('\n')}\n`
}
