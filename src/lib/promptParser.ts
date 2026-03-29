export type PromptAction = 'include' | 'exclude' | 'status' | 'build' | 'unknown'

export interface PromptIntent {
  action: PromptAction
  repos: string[]
  explanation: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractRepoTokens(input: string, knownRepos: string[]): string[] {
  const uniqueKnown = [...new Set(knownRepos.map((repo) => repo.trim()).filter(Boolean))]
  if (uniqueKnown.length > 0) {
    const lowerInput = input.toLowerCase()
    const matched: string[] = []

    for (const repo of uniqueKnown) {
      const escaped = escapeRegExp(repo.toLowerCase())
      const barePattern = new RegExp(`(^|[^a-zA-Z0-9._-])${escaped}([^a-zA-Z0-9._-]|$)`)
      const orgPattern = new RegExp(`[a-zA-Z0-9._-]+/${escaped}([^a-zA-Z0-9._-]|$)`)
      if (barePattern.test(lowerInput) || orgPattern.test(lowerInput)) {
        matched.push(repo)
      }
    }

    return [...new Set(matched)]
  }

  const stopwords = new Set([
    'include',
    'exclude',
    'remove',
    'status',
    'build',
    'map',
    'from',
    'the',
    'and',
    'in',
    'to',
    'for',
    'of',
    'with',
  ])

  const matches = input.match(/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+/g) ?? []
  return [...new Set(matches.filter((token) => !stopwords.has(token.toLowerCase())))]
}

export function parsePromptIntent(instruction: string, knownRepos: string[] = []): PromptIntent {
  const lower = instruction.toLowerCase()

  if (/\bstatus\b/.test(lower)) {
    return {
      action: 'status',
      repos: [],
      explanation: 'Show map status.',
    }
  }

  if (/\bbuild\b/.test(lower)) {
    return {
      action: 'build',
      repos: [],
      explanation: 'Build map artifacts for current scope.',
    }
  }

  if (/\b(include|add)\b/.test(lower)) {
    return {
      action: 'include',
      repos: extractRepoTokens(instruction, knownRepos),
      explanation: 'Add repositories to explicit include overrides.',
    }
  }

  if (/\b(exclude|remove|drop)\b/.test(lower)) {
    return {
      action: 'exclude',
      repos: extractRepoTokens(instruction, knownRepos),
      explanation: 'Add repositories to explicit exclude overrides.',
    }
  }

  return {
    action: 'unknown',
    repos: extractRepoTokens(instruction, knownRepos),
    explanation: 'No deterministic action matched.',
  }
}

export function renderPromptPreview(intent: PromptIntent): string {
  const repoText = intent.repos.length > 0 ? intent.repos.join(', ') : 'none'
  return [
    '# Prompt Preview',
    '',
    `- Action: ${intent.action}`,
    `- Repositories: ${repoText}`,
    `- Explanation: ${intent.explanation}`,
    '',
  ].join('\n')
}
