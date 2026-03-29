import {SCHEMA_VERSION} from './constants'
import {ContractRecord, HandoffArtifact, ScopeManifest} from './types'

export function buildHandoff(
  mapId: string,
  serviceId: string,
  scope: ScopeManifest,
  contracts: ContractRecord[],
): HandoffArtifact {
  const targets = scope.effective
    .filter((repo) => repo !== serviceId)
    .map((repo) => {
      const impactedContracts = contracts
        .filter((contract) => contract.repo === repo || contract.producers.includes(serviceId))
        .slice(0, 8)

      return {
        repo,
        summary: `New service '${serviceId}' is available. Validate integration touchpoints for ${repo}.`,
        requiredChanges: [
          `Review service-to-service dependency requirements for ${serviceId}.`,
          `Update integration configuration and environment variables if ${repo} consumes ${serviceId}.`,
          'Add compatibility checks in CI for the updated API or event contracts.',
        ],
        contractImpacts:
          impactedContracts.length > 0
            ? impactedContracts.map((contract) => `${contract.type}:${contract.path}`)
            : ['No direct contracts detected; validate runtime dependencies manually.'],
        sequencing: 'Integrate in staging first, validate observability signals, then promote to production.',
      }
    })

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    serviceId,
    targets,
  }
}

export function renderHandoffMarkdown(handoff: HandoffArtifact): string {
  const lines = [
    `# Handoff Draft: ${handoff.serviceId}`,
    '',
    `- Generated: ${handoff.generatedAt}`,
    `- Map: ${handoff.mapId}`,
    '',
  ]

  for (const target of handoff.targets) {
    lines.push(`## ${target.repo}`)
    lines.push('')
    lines.push(target.summary)
    lines.push('')
    lines.push('Required changes:')
    for (const item of target.requiredChanges) {
      lines.push(`- ${item}`)
    }
    lines.push('')
    lines.push('Contract impacts:')
    for (const impact of target.contractImpacts) {
      lines.push(`- ${impact}`)
    }
    lines.push('')
    lines.push(`Sequencing: ${target.sequencing}`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}
