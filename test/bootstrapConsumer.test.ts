import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  bootstrapConsumer,
  resolveConsumerTargetDir,
  resolvePinnedVersion,
  writeInstallManifest,
  writePinnedWrapperScript,
} from '../src/lib/bootstrapConsumer'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-bootstrap-consumer-'))
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

describe('bootstrapConsumer helpers', () => {
  it('resolves dedicated target dir to ./<design-repo> by default', () => {
    const cwd = '/workspace/root'
    expect(resolveConsumerTargetDir('dedicated', 'acme-system-designer', undefined, cwd)).toBe(
      path.resolve(cwd, 'acme-system-designer'),
    )
  })

  it('resolves in-place target dir to current directory by default', () => {
    const cwd = '/workspace/root'
    expect(resolveConsumerTargetDir('in-place', 'ignored', undefined, cwd)).toBe(path.resolve(cwd))
  })

  it('resolves pinned version from explicit pin and fallback package version', () => {
    expect(resolvePinnedVersion(undefined, '0.1.0')).toBe('0.1.0')
    expect(resolvePinnedVersion('v1.2.3', '0.1.0')).toBe('1.2.3')
    expect(() => resolvePinnedVersion('latest', '0.1.0')).toThrow(/Invalid --pin/)
  })

  it('writes install manifest and pinned wrapper script', () => {
    const dir = mkTempDir()
    const manifestPath = writeInstallManifest(dir, 'acme', 'system-design', 'dedicated', '0.1.0')
    const wrapperPath = writePinnedWrapperScript(dir, '0.1.0')

    expect(fs.existsSync(manifestPath)).toBe(true)
    expect(fs.existsSync(wrapperPath)).toBe(true)
    expect(fs.readFileSync(wrapperPath, 'utf8')).toContain('npx --yes sdx-cli@0.1.0 sdx "$@"')
    const mode = fs.statSync(wrapperPath).mode & 0o777
    expect(mode).toBe(0o755)
  })
})

describe('bootstrapConsumer integration', () => {
  it('creates dedicated workspace without mutating caller repo root', async () => {
    const root = mkTempDir()
    const result = await bootstrapConsumer({
      org: 'acme',
      designRepo: 'acme-system-designer',
      mode: 'dedicated',
      pin: '0.1.0',
      cwd: root,
    })

    const targetDir = path.join(root, 'acme-system-designer')
    expect(result.targetDir).toBe(targetDir)
    expect(fs.existsSync(path.join(targetDir, '.sdx', 'config.json'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, '.sdx', 'install.json'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'scripts', 'sdx'))).toBe(true)
    expect(fs.existsSync(path.join(root, '.sdx', 'config.json'))).toBe(false)
  })

  it('skips default-map seeding when token is missing', async () => {
    const prevToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN

    try {
      const root = mkTempDir()
      const result = await bootstrapConsumer({
        org: 'acme',
        designRepo: 'system-design',
        mode: 'dedicated',
        seedDefaultMap: true,
        pin: '0.1.0',
        cwd: root,
      })

      expect(result.seededDefaultMap).toBe(false)
      expect(result.warnings.some((warning) => warning.includes('GITHUB_TOKEN'))).toBe(true)
      expect(fs.existsSync(path.join(result.targetDir, 'maps', 'all-services', 'service-map.json'))).toBe(false)
    } finally {
      if (prevToken !== undefined) {
        process.env.GITHUB_TOKEN = prevToken
      } else {
        delete process.env.GITHUB_TOKEN
      }
    }
  })

  it('fails safely when create-remote is used outside dedicated mode', async () => {
    const root = mkTempDir()
    await expect(
      bootstrapConsumer({
        org: 'acme',
        designRepo: 'system-design',
        mode: 'in-place',
        createRemote: true,
        pin: '0.1.0',
        cwd: root,
      }),
    ).rejects.toThrow(/--create-remote can only be used/)
  })

  it('fails safely when create-remote lacks token', async () => {
    const prevToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN

    try {
      const root = mkTempDir()
      await expect(
        bootstrapConsumer({
          org: 'acme',
          designRepo: 'system-design',
          mode: 'dedicated',
          createRemote: true,
          pin: '0.1.0',
          cwd: root,
        }),
      ).rejects.toThrow(/Missing GitHub token/)
    } finally {
      if (prevToken !== undefined) {
        process.env.GITHUB_TOKEN = prevToken
      } else {
        delete process.env.GITHUB_TOKEN
      }
    }
  })
})
