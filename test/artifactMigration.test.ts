import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {isManagedArtifactPath, isManagedArtifactPayload} from '../src/lib/artifactMigration'

describe('artifactMigration', () => {
  const cwd = '/workspace'

  it('matches managed artifact paths', () => {
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/service-map.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/scope.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/architecture-overrides.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/architecture/model.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/architecture/validation.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/flow/graph.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/flow/findings.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'plans/reviews/review.json'))).toBe(true)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'codex/runs/run.json'))).toBe(true)
  })

  it('does not match unrelated json files', () => {
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'maps/core/custom.json'))).toBe(false)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'plans/input.json'))).toBe(false)
    expect(isManagedArtifactPath(cwd, path.join(cwd, 'package.json'))).toBe(false)
  })

  it('accepts only artifact-like payloads', () => {
    expect(isManagedArtifactPayload({schemaVersion: '1.0.0'})).toBe(true)
    expect(isManagedArtifactPayload({generatedAt: '2026-01-01T00:00:00.000Z'})).toBe(true)
    expect(isManagedArtifactPayload({foo: 'bar'})).toBe(false)
    expect(isManagedArtifactPayload(['not', 'an', 'object'])).toBe(false)
  })
})
