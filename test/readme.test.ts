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
      'README.md': [
        '# API Service',
        '',
        'API Service handles account and billing API requests for the platform.',
        '',
        '## Responsibilities',
        '- Serve REST endpoints for account lifecycle and billing configuration.',
        '',
        '## API',
        '- OpenAPI endpoint set for account and billing resources.',
        '',
        '## Deployment',
        '- Deployed to Kubernetes using Helm.',
        '',
        '## Local Development',
        '```bash',
        'npm install',
        'npm run dev',
        '```',
        '',
        '## Security',
        '- Uses OAuth2 service tokens and request signing.',
      ].join('\n'),
      'docs/runbooks/incidents.md': [
        '# Incident Runbook',
        '',
        'Escalate to #platform-oncall when API error rate exceeds SLO.',
      ].join('\n'),
      'openapi.yaml': 'openapi: 3.0.3\ninfo:\n  title: API Service\n  version: 1.1.0\n',
      'src/main.ts': [
        "import express from 'express'",
        'const app = express()',
        "app.get('/v1/accounts', (_req, res) => res.json({ok: true}))",
        'export default app',
      ].join('\n'),
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
      'README.md': [
        '# Events Service',
        '',
        'Events Service publishes domain events consumed by API clients and jobs.',
        '',
        '## Responsibilities',
        '- Publish event streams for customer lifecycle and billing updates.',
        '',
        '## Async',
        '- Publishes to Kafka topics for downstream consumers.',
        '',
        '## Data',
        '- Uses Postgres and Redis for event state and dedupe.',
      ].join('\n'),
      'docs/adr/adr-001-event-versioning.md': [
        '# ADR-001 Event Versioning',
        '',
        'We version events with semantic topic names and schema compatibility gates.',
      ].join('\n'),
      'asyncapi.yaml': 'asyncapi: 2.6.0\ninfo:\n  title: Events\n  version: 2.0.0\n',
      'src/queue.ts': [
        'export function publishBillingUpdate() {',
        "  publish('billing.updated')",
        '}',
      ].join('\n'),
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

function mockCodexRun(root: string, stdout: string) {
  return {
    promptPath: path.join(root, 'codex', 'runs', 'mock.prompt.txt'),
    runMarkdownPath: path.join(root, 'codex', 'runs', 'mock.md'),
    runJsonPath: path.join(root, 'codex', 'runs', 'mock.json'),
    exitCode: 0 as const,
    invocationMode: 'stdin' as const,
    stdout,
    stderr: '',
  }
}

function llmSectionsPayload(sections: Array<{id: ReadmeSectionId; body: string[]}>): string {
  return JSON.stringify({sections})
}

describe('docs readme generator', () => {
  it('generates useful README content from repo docs and remains idempotent', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const diagramsDir = path.join(root, 'docs', 'architecture', 'platform-core', 'diagrams')
    expect(fs.existsSync(path.join(diagramsDir, 'system-context.mmd'))).toBe(false)

    const first = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      deterministic: true,
    })

    expect(first.wroteFile).toBe(true)
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(diagramsDir, 'system-context.mmd'))).toBe(true)
    expect(fs.existsSync(path.join(diagramsDir, 'service-dependency.mmd'))).toBe(true)
    expect(fs.existsSync(path.join(diagramsDir, 'core-request-flow.mmd'))).toBe(true)

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('# acme System Architecture')
    expect(readme).toContain('## Service catalog table')
    expect(readme).toContain('Service purpose highlights')
    expect(readme).toContain('API Service handles account and billing API requests for the platform.')
    expect(readme).toContain('[System context diagram](./docs/architecture/platform-core/diagrams/system-context.mmd)')
    expect(readme).toContain('[Endpoint communication graph](./docs/architecture/platform-core/diagrams/flow/endpoint-communication.mmd)')
    expect(readme).toContain('### Service deep dives')
    expect(readme).toContain('GET /v1/accounts')
    expect(readme).toContain('billing.updated')
    expect(readme).toContain('### Known unknowns')
    expect(readme).not.toContain('<!-- SDX:SECTION:')

    const second = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      deterministic: true,
    })

    expect(second.changed).toBe(false)
    expect(second.wroteFile).toBe(false)

    context.db.close()
  })

  it('applies include then exclude section filtering with exclude precedence', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const result = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      output: 'README.filtered.md',
      includeSections: ['what_is_this_system', 'service_catalog'] as ReadmeSectionId[],
      excludeSections: ['service_catalog'] as ReadmeSectionId[],
      deterministic: true,
    })

    expect(result.sections).toEqual(['what_is_this_system'])

    const readme = fs.readFileSync(path.join(root, 'README.filtered.md'), 'utf8')
    expect(readme).toContain('## What this org/system is')
    expect(readme).not.toContain('## Service catalog table')

    context.db.close()
  })

  it('uses JSON config over YAML and validates config schema', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const appDir = path.join(root, '.sdx')
    fs.mkdirSync(appDir, {recursive: true})
    fs.writeFileSync(path.join(appDir, 'readme.config.yaml'), 'customIntro: "YAML intro"\n', 'utf8')
    fs.writeFileSync(path.join(appDir, 'readme.config.json'), JSON.stringify({customIntro: 'JSON intro'}, null, 2), 'utf8')

    await generateReadme({mapId: 'platform-core', db: context.db, cwd: root, output: 'README.config.md', deterministic: true})

    const content = fs.readFileSync(path.join(root, 'README.config.md'), 'utf8')
    expect(content).toContain('JSON intro')
    expect(content).not.toContain('YAML intro')

    fs.writeFileSync(path.join(appDir, 'readme.config.json'), JSON.stringify({staleThresholdHours: -1}, null, 2), 'utf8')

    await expect(() =>
      generateReadme({
        mapId: 'platform-core',
        db: context.db,
        cwd: root,
        output: 'README.invalid.md',
        deterministic: true,
      }),
    ).rejects.toThrow()

    context.db.close()
  })

  it('fails check mode when artifacts are stale', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const appDir = path.join(root, '.sdx')
    fs.mkdirSync(appDir, {recursive: true})
    fs.writeFileSync(path.join(appDir, 'readme.config.json'), JSON.stringify({staleThresholdHours: 0.000001}, null, 2), 'utf8')

    await generateReadme({mapId: 'platform-core', db: context.db, cwd: root, deterministic: true})

    const checked = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      check: true,
      deterministic: true,
    })

    expect(checked.checkPassed).toBe(false)
    expect(checked.staleSources.length).toBeGreaterThan(0)

    context.db.close()
  })

  it('fails check mode when required flow artifacts are missing', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const checked = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      check: true,
      deterministic: true,
    })

    expect(checked.checkPassed).toBe(false)
    expect(checked.missingSources.some((source) => source.label === 'Flow graph')).toBe(true)

    context.db.close()
  })

  it('supports dry-run without writing files and emits unified diff', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const result = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      dryRun: true,
      deterministic: true,
    })

    expect(result.wroteFile).toBe(false)
    expect(result.changed).toBe(true)
    expect(result.diff).toContain('--- README.md.current')
    expect(result.diff).toContain('+++ README.md.next')
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(false)

    context.db.close()
  })

  it('renders Unknown values instead of omitting unresolved fields', async () => {
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

    await generateReadme({mapId: 'minimal-map', db: context.db, cwd: root, deterministic: true})

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('Unknown')
    expect(readme).toContain('| Service name | Repository | Owner/team | Runtime/framework | API/event surface | Dependencies | Data stores | Deploy target | Tier/criticality | Status |')

    context.db.close()
  })

  it('produces a stable evidence hash for identical deterministic inputs', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)

    const first = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      deterministic: true,
      dryRun: true,
    })

    const second = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      deterministic: true,
      dryRun: true,
    })

    expect(first.evidenceHash).toBe(second.evidenceHash)
    context.db.close()
  })

  it('generates README via LLM mode with sentence citations and passes check parity', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)
    const configDir = path.join(root, '.sdx')
    fs.mkdirSync(configDir, {recursive: true})
    fs.writeFileSync(path.join(configDir, 'readme.config.json'), JSON.stringify({llm: {maxRetries: 0}}, null, 2), 'utf8')

    const response = llmSectionsPayload([
      {
        id: 'what_is_this_system',
        body: [
          '- Map platform-core belongs to org acme. [src:scope]',
          '- Services include api-service and events-service. [src:service-map-json]',
        ],
      },
      {
        id: 'architecture_glance',
        body: [
          '- The service map includes api-service and events-service nodes. [src:service-map-json]',
          '- Flow graph artifacts are generated for platform-core. [src:flow-graph]',
        ],
      },
    ])

    const generated = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
      codexRunner: () => mockCodexRun(root, response),
    })

    expect(generated.verificationPassed).toBe(true)
    expect(generated.unsupportedClaimCount).toBe(0)
    expect(generated.llmRunPath).toContain('codex/runs/')

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    expect(readme).toContain('[src:scope]')
    expect(readme).toContain('SDX:LLM:EVIDENCE_HASH')

    const checked = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
      check: true,
    })

    expect(checked.checkPassed).toBe(true)
    context.db.close()
  })

  it('hard-fails LLM mode when citations are missing and does not write README', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)
    const configDir = path.join(root, '.sdx')
    fs.mkdirSync(configDir, {recursive: true})
    fs.writeFileSync(path.join(configDir, 'readme.config.json'), JSON.stringify({llm: {maxRetries: 0}}, null, 2), 'utf8')

    const invalid = llmSectionsPayload([
      {
        id: 'what_is_this_system',
        body: ['Map platform-core belongs to org acme.'],
      },
      {
        id: 'architecture_glance',
        body: ['Service map includes api-service and events-service nodes. [src:service-map-json]'],
      },
    ])

    await expect(() =>
      generateReadme({
        mapId: 'platform-core',
        db: context.db,
        cwd: root,
        includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
        codexRunner: () => mockCodexRun(root, invalid),
      }),
    ).rejects.toThrow(/failed/)

    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(false)
    context.db.close()
  })

  it('fails llm check mode on evidence hash drift and invalid source citations', async () => {
    const root = mkTempDir()
    const context = setupWorkspaceWithMap(root)
    const configDir = path.join(root, '.sdx')
    fs.mkdirSync(configDir, {recursive: true})
    fs.writeFileSync(path.join(configDir, 'readme.config.json'), JSON.stringify({llm: {maxRetries: 0}}, null, 2), 'utf8')

    const response = llmSectionsPayload([
      {
        id: 'what_is_this_system',
        body: [
          '- Map platform-core belongs to org acme. [src:scope]',
          '- Services include api-service and events-service. [src:service-map-json]',
        ],
      },
      {
        id: 'architecture_glance',
        body: ['- Service map includes api-service and events-service nodes. [src:service-map-json]'],
      },
    ])

    await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
      codexRunner: () => mockCodexRun(root, response),
    })

    const readmePath = path.join(root, 'README.md')
    let readme = fs.readFileSync(readmePath, 'utf8')
    readme = readme.replace(/SDX:LLM:EVIDENCE_HASH=[a-f0-9]+/, 'SDX:LLM:EVIDENCE_HASH=deadbeef')
    fs.writeFileSync(readmePath, readme, 'utf8')

    const hashCheck = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
      check: true,
    })
    expect(hashCheck.checkPassed).toBe(false)

    await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
      codexRunner: () => mockCodexRun(root, response),
    })

    readme = fs.readFileSync(readmePath, 'utf8').replace(/\[src:scope\]/g, '[src:not-real]')
    fs.writeFileSync(readmePath, readme, 'utf8')

    const citationCheck = await generateReadme({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      includeSections: ['what_is_this_system', 'architecture_glance'] as ReadmeSectionId[],
      check: true,
    })
    expect(citationCheck.checkPassed).toBe(false)
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
