export interface BootstrapQuickTarget {
  org: string
  designRepo: string
}

const DEFAULT_DESIGN_REPO_SUFFIX = 'system-designer'
const ORG_REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/
const ORG_PATTERN = /^[a-zA-Z0-9._-]+$/

function normalizeTarget(target: string): string {
  let normalized = target.trim()
  normalized = normalized.replace(/^https?:\/\/github\.com\//i, '')
  normalized = normalized.replace(/\.git$/i, '')
  normalized = normalized.replace(/^\/+|\/+$/g, '')
  return normalized
}

function defaultDesignRepoForOrg(org: string): string {
  return `${org}-${DEFAULT_DESIGN_REPO_SUFFIX}`
}

export function parseBootstrapQuickTarget(target: string): BootstrapQuickTarget {
  const normalized = normalizeTarget(target)

  if (ORG_REPO_PATTERN.test(normalized)) {
    const [org, designRepo] = normalized.split('/')
    return {org, designRepo}
  }

  if (ORG_PATTERN.test(normalized)) {
    return {org: normalized, designRepo: defaultDesignRepoForOrg(normalized)}
  }

  throw new Error(
    "Invalid target. Use <org> or <org>/<design-repo> (example: dana0550/dana0550-system-designer).",
  )
}
