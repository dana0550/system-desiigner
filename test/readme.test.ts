import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {generateReadme, parseReadmeSectionList, ReadmeSectionId} from '../src/lib/readme'
import {initProject} from '../src/lib/project'
import {upsertRepos} from '../src/lib/repoRegistry'
import {createScopeManifest, saveScopeManifest} from '../src/lib/scope'
import {RepoRecord} from '../src/lib/types'
import {buildMapArtifacts, extractContractArtifacts, generateDocsArtifacts} from '../src/lib/workflows'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-readme-'))
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
    const fullPath = path.join(repoPath, relativePath)
    fs.mkdirSync(path.dirname(fullPath), {recursive: true})
    fs.writeFileSync(fullPath, body, 'utf8')
  }

  return repoPath
}

function repoRecord(name: string, localPath: string, now: string): RepoRecord {
  return {
    name,
    fullName: `acme/${name}`,
    org: 'acme',
    defaultBranch: 'main',
    archived: false,
    fork: false,
    localPath,
    source: 'hybrid',
    lastSyncedAt: now,
  }
}

function setupWorkspaceWithMap(root: string): ReturnType<typeof initProject> {
  const now = new Date().toISOString()

  const apiPath = createRepo(
    root,
    'api-service',
    {
      name: 'api-service',
      dependencies: {'events-service': '^1.0.0'},
    },
    {
      'openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: API Service\n  version: 1.1.0\n',
      'src/main.ts': 'export const app = true\n',
      'CODEOWNERS': '* @acme/platform\n',
      'vercel.json': '{"version":2}\n',
    },
  )

  const eventsPath = createRepo(
    root,
    'events-service',
    {
      name: 'events-service',
      dependencies: {},
    },
    {
      'asyncapi.yaml': 'asyncapi: 2.6.0\ninfo:\n  title: Events\n  version: 2.0.0\n',
      'src/queue.ts': 'export const queue = true\n',
      '.github/CODEOWNERS': '* @acme/events\n',
      'Dockerfile': 'FROM node:20\n',
    },
  )

  const context = initProject(root)
  upsertRepos(context.db, [repoRecord('api-service', apiPath, now), repoRecord('events-service', eventsPath, now)])

  const scope = createScopeManifest('platform-core', 'acme', ['api-service', 'events-service'], root)
  saveScopeManifest(scope, root)

  buildMapArtifacts('platform-core', context.db, root)
  extractContractArtifacts('platform-core', context.db, root)
  generateDocsArtifacts('platform-core', context.db, root)

  return context
}

describe('docs readme generator', () => {
  it('generates README with required sections and diagrams and remains idempotent', () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const diagramsDir = path.join(root, 'docs', 'architecture', 'platform-core', 'diagrams')
    expect(fs.existsSync(path.join(diagramsDir, 'system-context.mmd'))).toBe(false)

    const first = generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
    })

    expect(first.wroteFile).toBe(true)
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(diagramsDir, 'system-context.mmd'))).toBe(true)
    expect(fs.existsSync(path.join(diagramsDir, 'service-dependency.mmd'))).toBe(true)
    expect(fs.existsSync(path.join(diagramsDir, 'core-request-flow.mmd'))).toBe(true)

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('<!-- SDX:SECTION:what_is_this_system:START -->')
    expect(readme).toContain('<!-- SDX:SECTION:changelog_metadata:END -->')
    expect(readme).toContain('[System context diagram](./docs/architecture/platform-core/diagrams/system-context.mmd)')

    const second = generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
    })

    expect(second.changed).toBe(false)
    expect(second.wroteFile).toBe(false)

    context.db.close()
  })

  it('applies include then exclude section filtering with exclude precedence', () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const result = generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      output: 'README.filtered.md',
      includeSections: ['what_is_this_system', 'service_catalog'] as ReadmeSectionId[],
      excludeSections: ['service_catalog'] as ReadmeSectionId[],
    })

    expect(result.sections).toEqual(['what_is_this_system'])

    const readme = fs.readFileSync(path.join(root, 'README.filtered.md'), 'utf8')
    expect(readme).toContain('<!-- SDX:SECTION:what_is_this_system:START -->')
    expect(readme).not.toContain('<!-- SDX:SECTION:service_catalog:START -->')

    context.db.close()
  })

  it('preserves manual section blocks exactly between regenerations', () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    generateReadme({mapId: 'platform-core', db: context.db, cwd: root})

    const readmePath = path.join(root, 'README.md')
    const original = fs.readFileSync(readmePath, 'utf8')
    const manualText = '\nTeam note: keep this exact wording.\n'

    const updated = original.replace(
      /<!-- SDX:SECTION:service_catalog:MANUAL:START -->[\s\S]*?<!-- SDX:SECTION:service_catalog:MANUAL:END -->/,
      `<!-- SDX:SECTION:service_catalog:MANUAL:START -->${manualText}<!-- SDX:SECTION:service_catalog:MANUAL:END -->`,
    )
    fs.writeFileSync(readmePath, updated, 'utf8')

    generateReadme({mapId: 'platform-core', db: context.db, cwd: root})

    const after = fs.readFileSync(readmePath, 'utf8')
    expect(after).toContain(manualText.trim())

    context.db.close()
  })

  it('uses JSON config over YAML and validates config schema', () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const appDir = path.join(root, '.sdx')
    fs.mkdirSync(appDir, {recursive: true})
    fs.writeFileSync(path.join(appDir, 'readme.config.yaml'), 'customIntro: "YAML intro"\n', 'utf8')
    fs.writeFileSync(path.join(appDir, 'readme.config.json'), JSON.stringify({customIntro: 'JSON intro'}, null, 2), 'utf8')

    generateReadme({mapId: 'platform-core', db: context.db, cwd: root, output: 'README.config.md'})

    const content = fs.readFileSync(path.join(root, 'README.config.md'), 'utf8')
    expect(content).toContain('JSON intro')
    expect(content).not.toContain('YAML intro')

    fs.writeFileSync(path.join(appDir, 'readme.config.json'), JSON.stringify({staleThresholdHours: -1}, null, 2), 'utf8')

    expect(() =>
      generateReadme({
        mapId: 'platform-core',
        db: context.db,
        cwd: root,
        output: 'README.invalid.md',
      }),
    ).toThrow()

    context.db.close()
  })

  it('fails check mode when artifacts are stale', () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const appDir = path.join(root, '.sdx')
    fs.mkdirSync(appDir, {recursive: true})
    fs.writeFileSync(path.join(appDir, 'readme.config.json'), JSON.stringify({staleThresholdHours: 0.000001}, null, 2), 'utf8')

    generateReadme({mapId: 'platform-core', db: context.db, cwd: root})

    const checked = generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      check: true,
    })

    expect(checked.checkPassed).toBe(false)
    expect(checked.staleSources.length).toBeGreaterThan(0)

    context.db.close()
  })

  it('supports dry-run without writing files and emits unified diff', () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const result = generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      dryRun: true,
    })

    expect(result.wroteFile).toBe(false)
    expect(result.changed).toBe(true)
    expect(result.diff).toContain('--- README.md.current')
    expect(result.diff).toContain('+++ README.md.next')
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(false)

    context.db.close()
  })

  it('renders Unknown values instead of omitting unresolved fields', () => {
    const root = mkTempDir()

    const repoPath = createRepo(
      root,
      'minimal-service',
      {
        name: 'minimal-service',
        dependencies: {},
      },
      {
        'src/index.ts': 'export const ok = true\n',
      },
    )

    const context = initProject(root)
    upsertRepos(context.db, [repoRecord('minimal-service', repoPath, new Date().toISOString())])

    const scope = createScopeManifest('minimal-map', 'acme', ['minimal-service'], root)
    saveScopeManifest(scope, root)
    buildMapArtifacts('minimal-map', context.db, root)

    generateReadme({mapId: 'minimal-map', db: context.db, cwd: root})

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('Unknown')
    expect(readme).toContain('| Service name | Repository | Owner/team | Runtime/framework | API/event surface | Dependencies | Data stores | Deploy target | Tier/criticality | Status |')

    context.db.close()
  })

  it('parses section lists and rejects invalid section IDs', () => {
    expect(parseReadmeSectionList('what_is_this_system,service_catalog')).toEqual([
      'what_is_this_system',
      'service_catalog',
    ])

    expect(() => parseReadmeSectionList('what_is_this_system,does_not_exist')).toThrow(/Unknown section id/)
  })
})
