import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {initProject} from '../src/lib/project'
import {setLocalRepoPath, upsertRepos, getRepoByName} from '../src/lib/repoRegistry'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-repo-registry-'))
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

describe('repo registry local path registration', () => {
  it('sets lastSyncedAt when inserting and updating local repos', () => {
    const root = mkTempDir()
    const localRepo = path.join(root, 'repos', 'api-service')
    fs.mkdirSync(localRepo, {recursive: true})

    const context = initProject(root)

    const inserted = setLocalRepoPath(context.db, 'api-service', localRepo, 'acme')
    expect(inserted.lastSyncedAt).toBeDefined()

    upsertRepos(context.db, [
      {
        name: 'github-service',
        fullName: 'acme/github-service',
        org: 'acme',
        defaultBranch: 'main',
        archived: false,
        fork: false,
        source: 'github',
        lastSyncedAt: new Date().toISOString(),
      },
    ])

    const hybridLocal = path.join(root, 'repos', 'github-service')
    fs.mkdirSync(hybridLocal, {recursive: true})
    const updated = setLocalRepoPath(context.db, 'github-service', hybridLocal, 'acme')
    expect(updated.lastSyncedAt).toBeDefined()
    expect(updated.source).toBe('hybrid')

    const fetched = getRepoByName(context.db, 'github-service')
    expect(fetched.lastSyncedAt).toBeDefined()

    context.db.close()
  })
})
