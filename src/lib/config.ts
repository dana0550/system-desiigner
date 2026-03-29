import {SdxConfig} from './types'
import {SCHEMA_VERSION} from './constants'
import {fileExists, readJsonFile, writeJsonFile} from './fs'
import {getConfigPath, getProjectRoot} from './paths'

export function createDefaultConfig(cwd = process.cwd()): SdxConfig {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    outputRepo: {
      rootDir: getProjectRoot(cwd),
    },
    codex: {
      cmd: process.env.CODEX_CMD ?? 'codex',
    },
    github: {
      tokenEnv: 'GITHUB_TOKEN',
    },
  }
}

export function saveConfig(config: SdxConfig, cwd = process.cwd()): void {
  config.updatedAt = new Date().toISOString()
  writeJsonFile(getConfigPath(cwd), config)
}

export function loadConfig(cwd = process.cwd()): SdxConfig {
  const configPath = getConfigPath(cwd)
  if (!fileExists(configPath)) {
    throw new Error('sdx is not initialized. Run `sdx init` first.')
  }

  return readJsonFile<SdxConfig>(configPath)
}

export function hasConfig(cwd = process.cwd()): boolean {
  return fileExists(getConfigPath(cwd))
}
