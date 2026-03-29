import fs from 'node:fs'
import path from 'node:path'
import {createBootstrapStructure} from './bootstrap'
import {SCHEMA_VERSION} from './constants'
import {writeJsonFile, writeTextFile} from './fs'
import {ensureOrgRepo, fetchOrgRepos} from './github'
import {buildServiceMapArtifact, renderServiceMapMarkdown, renderServiceMapMermaid} from './mapBuilder'
import {loadProject, ensureMapDir, initProject, recordRun} from './project'
import {listAllRepos, upsertRepos} from './repoRegistry'
import {createScopeManifest, saveScopeManifest} from './scope'
import {saveConfig} from './config'
import {getCliPackageVersion} from './version'

const semver = require('semver') as {
  valid: (value: string) => string | null
}

export type ConsumerBootstrapMode = 'dedicated' | 'in-place'

export interface InstallManifest {
  schemaVersion: string
  generatedAt: string
  installedWithVersion: string
  installedAt: string
  mode: ConsumerBootstrapMode
  org: string
  designRepo: string
  templateSchemaVersion: string
}

export interface BootstrapConsumerOptions {
  org: string
  designRepo: string
  mode: ConsumerBootstrapMode
  targetDir?: string
  pin?: string
  seedDefaultMap?: boolean
  createRemote?: boolean
  cwd?: string
}

export interface BootstrapConsumerResult {
  targetDir: string
  pinnedVersion: string
  mode: ConsumerBootstrapMode
  remoteCreated: boolean
  remoteUrl?: string
  seededDefaultMap: boolean
  warnings: string[]
  nextSteps: string[]
}

export function resolveConsumerTargetDir(
  mode: ConsumerBootstrapMode,
  designRepo: string,
  targetDir: string | undefined,
  cwd = process.cwd(),
): string {
  if (targetDir && targetDir.trim().length > 0) {
    return path.resolve(cwd, targetDir)
  }

  if (mode === 'dedicated') {
    return path.resolve(cwd, designRepo)
  }

  return path.resolve(cwd)
}

export function resolvePinnedVersion(pin: string | undefined, currentVersion: string): string {
  const fallback = semver.valid(currentVersion)
  if (!fallback) {
    throw new Error(`Invalid package version: ${currentVersion}`)
  }

  if (!pin || pin.trim().length === 0) {
    return fallback
  }

  const normalized = semver.valid(pin)
  if (!normalized) {
    throw new Error(`Invalid --pin value '${pin}'. Use a concrete semver version (example: 0.1.0).`)
  }

  return normalized
}

export function writeInstallManifest(
  targetDir: string,
  org: string,
  designRepo: string,
  mode: ConsumerBootstrapMode,
  pinnedVersion: string,
): string {
  const now = new Date().toISOString()
  const payload: InstallManifest = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    installedWithVersion: pinnedVersion,
    installedAt: now,
    mode,
    org,
    designRepo,
    templateSchemaVersion: SCHEMA_VERSION,
  }

  const outPath = path.join(targetDir, '.sdx', 'install.json')
  writeJsonFile(outPath, payload)
  return outPath
}

export function writePinnedWrapperScript(targetDir: string, pinnedVersion: string): string {
  const scriptPath = path.join(targetDir, 'scripts', 'sdx')
  const body = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `npx --yes sdx-cli@${pinnedVersion} sdx "$@"`,
    '',
  ].join('\n')

  writeTextFile(scriptPath, body)
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}

function buildSeededAllServicesMap(org: string, targetDir: string): void {
  const context = loadProject(targetDir)
  const repos = listAllRepos(context.db)

  ensureMapDir('all-services', targetDir)
  const manifest = createScopeManifest(
    'all-services',
    org,
    repos.map((repo) => repo.name),
    targetDir,
  )

  const archivedOrFork = repos.filter((repo) => repo.archived || repo.fork).map((repo) => repo.name)
  manifest.explicitExclude = [...new Set([...manifest.explicitExclude, ...archivedOrFork])].sort((a, b) =>
    a.localeCompare(b),
  )
  saveScopeManifest(manifest, targetDir)
  recordRun(context.db, 'map_create', 'ok', 'all-services', {org, discovered: repos.length, seeded: true})

  const repoMap = new Map(repos.map((repo) => [repo.name, repo]))
  const artifact = buildServiceMapArtifact('all-services', manifest, repoMap)
  const mapDir = path.join(targetDir, 'maps', 'all-services')
  writeJsonFile(path.join(mapDir, 'service-map.json'), artifact)
  writeTextFile(path.join(mapDir, 'service-map.md'), renderServiceMapMarkdown(artifact))
  writeTextFile(path.join(mapDir, 'service-map.mmd'), renderServiceMapMermaid(artifact))

  recordRun(context.db, 'map_build', 'ok', 'all-services', {
    seeded: true,
    repos: artifact.repos.length,
    nodes: artifact.nodes.length,
    edges: artifact.edges.length,
  })
  context.db.close()
}

export async function bootstrapConsumer(options: BootstrapConsumerOptions): Promise<BootstrapConsumerResult> {
  const cwd = options.cwd ?? process.cwd()
  const mode = options.mode
  const targetDir = resolveConsumerTargetDir(mode, options.designRepo, options.targetDir, cwd)
  const pinnedVersion = resolvePinnedVersion(options.pin, getCliPackageVersion())
  const warnings: string[] = []
  const nextSteps: string[] = []
  const result: BootstrapConsumerResult = {
    targetDir,
    pinnedVersion,
    mode,
    remoteCreated: false,
    seededDefaultMap: false,
    warnings,
    nextSteps,
  }

  if (options.createRemote && mode !== 'dedicated') {
    throw new Error('--create-remote can only be used with --mode dedicated.')
  }

  if (mode === 'dedicated' && options.createRemote) {
    const token = process.env.GITHUB_TOKEN
    if (!token) {
      throw new Error('Missing GitHub token. Set GITHUB_TOKEN to use --create-remote.')
    }

    const remote = await ensureOrgRepo(options.org, options.designRepo, token)
    result.remoteCreated = remote.created
    result.remoteUrl = remote.htmlUrl
  }

  const initContext = initProject(targetDir)
  createBootstrapStructure(options.org, options.designRepo, targetDir)
  initContext.config.outputRepo.org = options.org
  initContext.config.outputRepo.repo = options.designRepo
  initContext.config.github.defaultOrg = options.org
  saveConfig(initContext.config, targetDir)
  recordRun(initContext.db, 'bootstrap_org', 'ok', undefined, {
    org: options.org,
    repo: options.designRepo,
    source: 'bootstrap_consumer',
  })
  initContext.db.close()

  writeInstallManifest(targetDir, options.org, options.designRepo, mode, pinnedVersion)
  writePinnedWrapperScript(targetDir, pinnedVersion)

  if (mode === 'dedicated' && !options.createRemote) {
    nextSteps.push(`gh repo create ${options.org}/${options.designRepo} --private`)
    nextSteps.push(`cd ${targetDir}`)
    nextSteps.push(`git init`)
    nextSteps.push(`git remote add origin git@github.com:${options.org}/${options.designRepo}.git`)
  }

  if (options.seedDefaultMap) {
    const context = loadProject(targetDir)
    const tokenEnvName = context.config.github.tokenEnv
    context.db.close()

    const token = process.env[tokenEnvName]
    if (!token) {
      warnings.push(`Skipping --seed-default-map: missing ${tokenEnvName}.`)
    } else {
      const syncContext = loadProject(targetDir)
      const repos = await fetchOrgRepos(options.org, token)
      upsertRepos(syncContext.db, repos)
      recordRun(syncContext.db, 'repo_sync', 'ok', undefined, {
        org: options.org,
        count: repos.length,
        seeded: true,
      })
      syncContext.db.close()
      if (repos.length === 0) {
        warnings.push(`Skipping --seed-default-map: no repositories discovered for org '${options.org}'.`)
      } else {
        buildSeededAllServicesMap(options.org, targetDir)
        result.seededDefaultMap = true
      }
    }
  }

  const finalize = loadProject(targetDir)
  recordRun(finalize.db, 'bootstrap_consumer', 'ok', undefined, {
    org: options.org,
    designRepo: options.designRepo,
    mode,
    targetDir,
    pinnedVersion,
    createRemote: Boolean(options.createRemote),
    seedDefaultMap: Boolean(options.seedDefaultMap),
    seededDefaultMap: result.seededDefaultMap,
    warnings: warnings.length,
  })
  finalize.db.close()

  return result
}
