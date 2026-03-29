import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {generateArchitecturePack, validateArchitecture} from '../src/lib/architecture'
import {initProject} from '../src/lib/project'
import {upsertRepos} from '../src/lib/repoRegistry'
import {createScopeManifest, saveScopeManifest} from '../src/lib/scope'
import {RepoRecord} from '../src/lib/types'
import {writeJsonFile} from '../src/lib/fs'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-architecture-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  }
})

function createRepo(root: string, name: string, packageJson: Record<string, unknown>, files: Record<string, string>): string {
  const repoPath = path.join(root, 'repos', name)
  fs.mkdirSync(repoPath, {recursive: true})
  fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8')

  for (const [relativePath, body] of Object.entries(files)) {
    const full = path.join(repoPath, relativePath)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, body, 'utf8')
  }

  return repoPath
}

function repoRecord(name: string, localPath: string): RepoRecord {
  return {
    name,
    fullName: `acme/${name}`,
    org: 'acme',
    defaultBranch: 'main',
    archived: false,
    fork: false,
    localPath,
    source: 'hybrid',
  }
}

describe('architecture generation', () => {
  it('generates org and per-service architecture pack artifacts', () => {
    const root = mkTempDir()

    const serviceAPath = createRepo(
      root,
      'service-a',
      {
        name: 'service-a',
        dependencies: {'service-b': '^1.0.0'},
      },
      {
        'openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: Service A\n  version: 1.0.0\n',
        'src/redis-client.ts': 'export const redis = true\n',
      },
    )

    const serviceBPath = createRepo(
      root,
      'service-b',
      {
        name: 'service-b',
        dependencies: {},
      },
      {
        'asyncapi.yaml': 'asyncapi: 2.6.0\ninfo:\n  title: Events\n  version: 1.0.0\n',
        'src/kafka-producer.ts': 'export const kafka = true\n',
      },
    )

    const context = initProject(root)
    upsertRepos(context.db, [repoRecord('service-a', serviceAPath), repoRecord('service-b', serviceBPath)])

    const scope = createScopeManifest('platform-core', 'acme', ['service-a', 'service-b'], root)
    saveScopeManifest(scope, root)

    const result = generateArchitecturePack({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
    })

    expect(fs.existsSync(result.modelPath)).toBe(true)
    expect(fs.existsSync(path.join(root, 'maps', 'platform-core', 'architecture-overrides.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'index.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'services', 'service-a.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'services', 'service-b.md'))).toBe(true)
    expect(result.generatedServices).toEqual(['service-a', 'service-b'])

    context.db.close()
  })

  it('supports org-only depth and targeted service generation', () => {
    const root = mkTempDir()

    const serviceAPath = createRepo(
      root,
      'service-a',
      {
        name: 'service-a',
        dependencies: {'service-b': '^1.0.0'},
      },
      {
        'openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: Service A\n  version: 1.0.0\n',
      },
    )

    const serviceBPath = createRepo(
      root,
      'service-b',
      {
        name: 'service-b',
        dependencies: {},
      },
      {
        'openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: Service B\n  version: 1.0.0\n',
      },
    )

    const context = initProject(root)
    upsertRepos(context.db, [repoRecord('service-a', serviceAPath), repoRecord('service-b', serviceBPath)])

    const scope = createScopeManifest('platform-core', 'acme', ['service-a', 'service-b'], root)
    saveScopeManifest(scope, root)

    const orgOnly = generateArchitecturePack({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      depth: 'org',
    })

    expect(orgOnly.generatedServices).toEqual([])
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'index.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'services', 'service-a.md'))).toBe(false)

    const targeted = generateArchitecturePack({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      depth: 'full',
      serviceId: 'service-a',
    })

    expect(targeted.generatedServices).toEqual(['service-a'])
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'services', 'service-a.md'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'docs', 'architecture', 'platform-core', 'services', 'service-b.md'))).toBe(false)

    context.db.close()
  })

  it('fails validation when overrides reference unknown services', () => {
    const root = mkTempDir()

    const serviceAPath = createRepo(
      root,
      'service-a',
      {
        name: 'service-a',
        dependencies: {},
      },
      {
        'openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: Service A\n  version: 1.0.0\n',
      },
    )

    const context = initProject(root)
    upsertRepos(context.db, [repoRecord('service-a', serviceAPath)])

    const scope = createScopeManifest('platform-core', 'acme', ['service-a'], root)
    saveScopeManifest(scope, root)

    const overridesPath = path.join(root, 'maps', 'platform-core', 'architecture-overrides.json')
    writeJsonFile(overridesPath, {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      mapId: 'platform-core',
      serviceMetadata: {
        'does-not-exist': {
          owner: 'team-x',
        },
      },
      assertedNodes: [],
      assertedEdges: [],
      suppressedEdges: [],
    })

    const validation = validateArchitecture({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
    })

    expect(validation.valid).toBe(false)
    expect(validation.errors.some((err) => err.includes('does-not-exist'))).toBe(true)

    context.db.close()
  })
})
