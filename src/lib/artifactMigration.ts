import path from 'node:path'

const MANAGED_ARTIFACT_PATTERNS = [
  /^maps\/[^/]+\/(scope|service-map|contracts)\.json$/,
  /^maps\/[^/]+\/architecture\/(model|validation)\.json$/,
  /^maps\/[^/]+\/architecture-overrides\.json$/,
  /^plans\/reviews\/.*\.json$/,
  /^plans\/.*-service-proposal\.json$/,
  /^handoffs\/.*\.json$/,
  /^codex\/(context-packs|runs)\/.*\.json$/,
]

function normalizeRelativePath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).replaceAll(path.sep, '/')
}

export function isManagedArtifactPath(cwd: string, filePath: string): boolean {
  const relative = normalizeRelativePath(cwd, filePath)
  return MANAGED_ARTIFACT_PATTERNS.some((pattern) => pattern.test(relative))
}

export function isManagedArtifactPayload(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return typeof candidate.generatedAt === 'string' || typeof candidate.schemaVersion === 'string'
}
