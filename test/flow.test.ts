import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {checkFlow, discoverFlow, generateFlowDiagrams, validateFlow} from '../src/lib/flow'
import {initProject} from '../src/lib/project'
import {upsertRepos} from '../src/lib/repoRegistry'
import {createScopeManifest, saveScopeManifest} from '../src/lib/scope'
import {RepoRecord} from '../src/lib/types'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-flow-'))
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

function createRepo(root: string, name: string, files: Record<string, string>, packageJson?: Record<string, unknown>): string {
  const repoPath = path.join(root, 'repos', name)
  fs.mkdirSync(repoPath, {recursive: true})

  if (packageJson) {
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8')
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoPath, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), {recursive: true})
    fs.writeFileSync(absolutePath, content, 'utf8')
  }

  return repoPath
}

function repo(name: string, localPath: string | undefined, now: string): RepoRecord {
  return {
    name,
    fullName: `acme/${name}`,
    org: 'acme',
    defaultBranch: 'main',
    archived: false,
    fork: false,
    localPath,
    source: localPath ? 'hybrid' : 'github',
    lastSyncedAt: now,
  }
}

describe('flow intelligence', () => {
  it('discovers endpoint-level flows, binds contracts, and emits diagrams', () => {
    const root = mkTempDir()
    const now = new Date().toISOString()

    const webPath = createRepo(
      root,
      'web-app',
      {
        'src/client.ts': [
          "export async function loadAccounts() {",
          "  return fetch('https://api-service.internal/v1/accounts')",
          '}',
        ].join('\n'),
      },
      {
        name: 'web-app',
        dependencies: {react: '^18.0.0'},
      },
    )

    const apiPath = createRepo(
      root,
      'api-service',
      {
        'src/server.ts': [
          "import express from 'express'",
          'const app = express()',
          "app.get('/v1/accounts', (_req, res) => res.json({ok: true}))",
          'export default app',
        ].join('\n'),
        'openapi.yaml': [
          'openapi: 3.0.3',
          'info:',
          '  title: API Service',
          '  version: 1.2.0',
          'paths:',
          '  /v1/accounts:',
          '    get:',
          '      operationId: listAccounts',
          '      responses:',
          "        '200':",
          '          description: ok',
        ].join('\n'),
      },
      {
        name: 'api-service',
        dependencies: {express: '^4.0.0'},
      },
    )

    const runtimeDir = path.join(root, 'runtime', 'otel', 'platform-core', 'prod')
    fs.mkdirSync(runtimeDir, {recursive: true})
    fs.writeFileSync(
      path.join(runtimeDir, 'traces.json'),
      JSON.stringify([
        {
          attributes: {
            'service.name': 'web-app',
            'http.method': 'GET',
            'http.route': '/v1/accounts',
            'peer.service': 'api-service',
            endTime: now,
          },
        },
      ]),
      'utf8',
    )

    const context = initProject(root)
    upsertRepos(context.db, [repo('web-app', webPath, now), repo('api-service', apiPath, now)])

    const scope = createScopeManifest('platform-core', 'acme', ['web-app', 'api-service'], root)
    saveScopeManifest(scope, root)

    const discovered = discoverFlow({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      env: 'all',
      dryRun: false,
    })

    expect(discovered.endpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/v1/accounts')).toBe(true)
    expect(discovered.endpoints.some((endpoint) => Boolean(endpoint.schemaRef))).toBe(true)
    expect(discovered.graph.edges.some((edge) => edge.from === 'client:web-app' && edge.type === 'http_call')).toBe(true)
    expect(fs.existsSync(discovered.graphPath)).toBe(true)

    const diagrams = generateFlowDiagrams({
      mapId: 'platform-core',
      cwd: root,
    })
    expect(fs.existsSync(diagrams.endpointCommunicationPath)).toBe(true)
    expect(fs.existsSync(diagrams.clientBackendPath)).toBe(true)
    expect(fs.existsSync(diagrams.eventLineagePath)).toBe(true)

    context.db.close()
  })

  it('fails validation when a scoped repository has no local clone', () => {
    const root = mkTempDir()
    const now = new Date().toISOString()

    const apiPath = createRepo(
      root,
      'api-service',
      {
        'src/server.ts': "export const ok = true\n",
      },
      {
        name: 'api-service',
      },
    )

    const context = initProject(root)
    upsertRepos(context.db, [repo('api-service', apiPath, now), repo('worker-service', undefined, now)])

    const scope = createScopeManifest('platform-core', 'acme', ['api-service', 'worker-service'], root)
    saveScopeManifest(scope, root)

    discoverFlow({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      dryRun: false,
    })

    const {validation} = validateFlow({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
    })

    expect(validation.valid).toBe(false)
    expect(validation.errors.some((error) => error.includes('no local clone path'))).toBe(true)

    context.db.close()
  })

  it('detects drift in flow check when graph changes', () => {
    const root = mkTempDir()
    const now = new Date().toISOString()

    const webPath = createRepo(
      root,
      'web-app',
      {
        'src/client.ts': "export const call = () => fetch('https://api-service.internal/v1/accounts')\n",
      },
      {
        name: 'web-app',
        dependencies: {react: '^18.0.0'},
      },
    )

    const apiPath = createRepo(
      root,
      'api-service',
      {
        'src/server.ts': "app.get('/v1/accounts', handler)\n",
        'openapi.yaml': [
          'openapi: 3.0.3',
          'info: {title: API, version: 1.0.0}',
          'paths:',
          '  /v1/accounts:',
          '    get: {}',
        ].join('\n'),
      },
      {
        name: 'api-service',
        dependencies: {express: '^4.0.0'},
      },
    )

    const context = initProject(root)
    upsertRepos(context.db, [repo('web-app', webPath, now), repo('api-service', apiPath, now)])

    const scope = createScopeManifest('platform-core', 'acme', ['web-app', 'api-service'], root)
    saveScopeManifest(scope, root)

    discoverFlow({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
      dryRun: false,
    })

    fs.writeFileSync(path.join(webPath, 'src/client.ts'), "export const call = () => fetch('https://api-service.internal/v2/accounts')\n", 'utf8')

    const {result} = checkFlow({
      mapId: 'platform-core',
      db: context.db,
      cwd: root,
    })

    expect(result.passed).toBe(false)
    expect(result.driftDetected).toBe(true)
    expect(result.errors.some((error) => error.includes('drift detected'))).toBe(true)

    context.db.close()
  })
})
