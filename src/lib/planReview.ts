import fs from 'node:fs'
import path from 'node:path'
import {PRIMER_DIMENSIONS, REQUIRED_NFR_KEYWORDS, SCHEMA_VERSION} from './constants'
import {PlanReviewArtifact, ScopeManifest, ServiceMapArtifact} from './types'

function detectMissingNfrs(planText: string): string[] {
  const lower = planText.toLowerCase()
  return REQUIRED_NFR_KEYWORDS.filter((keyword) => !lower.includes(keyword))
}

function detectImpactedRepos(planText: string, scope: ScopeManifest): string[] {
  const lower = planText.toLowerCase()
  return scope.effective.filter((repo) => lower.includes(repo.toLowerCase()))
}

function detectAssumptions(planText: string): string[] {
  const lines = planText.split(/\r?\n/)
  return lines.filter((line) => /(tbd|todo|assume|unknown)/i.test(line)).slice(0, 20)
}

export function reviewPlan(
  mapId: string,
  planPath: string,
  scope: ScopeManifest,
  serviceMap: ServiceMapArtifact,
): PlanReviewArtifact {
  const absolute = path.resolve(planPath)
  const planText = fs.readFileSync(absolute, 'utf8')
  const missingNfrs = detectMissingNfrs(planText)
  const impactedRepos = detectImpactedRepos(planText, scope)
  const unresolvedAssumptions = detectAssumptions(planText)

  const decisions: PlanReviewArtifact['decisions'] = [
    {
      title: 'Service boundary fit',
      rationale:
        impactedRepos.length > 0
          ? 'Plan references existing repository surfaces and should align integration ownership before implementation.'
          : 'Plan does not reference existing repos. Validate downstream integration points before implementation.',
      confidence: impactedRepos.length > 0 ? 0.72 : 0.55,
      dimensions: ['api_style', 'operational_tradeoffs', 'reliability'],
    },
    {
      title: 'NFR completeness',
      rationale:
        missingNfrs.length === 0
          ? 'Plan includes required NFR categories for latency, availability, durability, SLO intent, and failure handling.'
          : `Plan is missing required NFR categories: ${missingNfrs.join(', ')}.`,
      confidence: missingNfrs.length === 0 ? 0.86 : 0.9,
      dimensions: ['scalability', 'reliability', 'observability', 'consistency_model'],
    },
    {
      title: 'System design coverage breadth',
      rationale: `Review used ${serviceMap.coverageTags.length} coverage dimensions aligned to the taxonomy baseline.`,
      confidence: 0.8,
      dimensions: [...PRIMER_DIMENSIONS],
    },
  ]

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId,
    planPath: absolute,
    missingNfrs,
    accepted: missingNfrs.length === 0,
    decisions,
    impactedRepos,
    unresolvedAssumptions,
  }
}

export function renderPlanReviewMarkdown(review: PlanReviewArtifact): string {
  const lines = [
    `# Plan Review: ${review.mapId}`,
    '',
    `- Generated: ${review.generatedAt}`,
    `- Plan: ${review.planPath}`,
    `- Accepted: ${review.accepted ? 'yes' : 'no'}`,
    `- Missing NFRs: ${review.missingNfrs.length === 0 ? 'none' : review.missingNfrs.join(', ')}`,
    '',
    '## Decisions',
    '',
    ...review.decisions.map(
      (decision) =>
        `- ${decision.title} (confidence ${decision.confidence.toFixed(2)}): ${decision.rationale} [${decision.dimensions.join(', ')}]`,
    ),
    '',
    '## Impacted Repositories',
    '',
    ...(review.impactedRepos.length > 0 ? review.impactedRepos.map((repo) => `- ${repo}`) : ['- none detected']),
    '',
    '## Unresolved Assumptions',
    '',
    ...(review.unresolvedAssumptions.length > 0 ? review.unresolvedAssumptions.map((line) => `- ${line}`) : ['- none']),
    '',
  ]

  return `${lines.join('\n')}\n`
}
