import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {createScopeManifest, saveScopeManifest} from '../src/lib/scope'
import {initProject} from '../src/lib/project'
import {publishNotices, publishSync} from '../src/lib/publishContracts'
import {upsertRepos} from '../src/lib/repoRegistry'
import {GithubPublishOps, PullLifecycle, UpsertPullRequestInput, UpsertPullRequestResult} from '../src/lib/githubPublish'
import {RepoRecord} from '../src/lib/types'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdx-publish-contracts-'))
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

class MockGithubPublishOps implements GithubPublishOps {
  private files = new Map<string, string>()
  private refs = new Set<string>()
  private prs = new Map<string, {number: number; url: string; title: string; body: string}>()
  private lifecycles = new Map<string, PullLifecycle>()
  private nextPullNumber = 1

  private fileKey(owner: string, repo: string, ref: string, filePath: string): string {
    return `${owner}/${repo}:${ref}:${filePath}`
  }

  private refKey(owner: string, repo: string, ref: string): string {
    return `${owner}/${repo}:${ref}`
  }

  seedFile(owner: string, repo: string, ref: string, filePath: string, body: string): void {
    this.refs.add(this.refKey(owner, repo, ref))
    this.files.set(this.fileKey(owner, repo, ref, filePath), body)
  }

  getFile(owner: string, repo: string, ref: string, filePath: string): string | undefined {
    return this.files.get(this.fileKey(owner, repo, ref, filePath))
  }

  async ensureBranch(owner: string, repo: string, branch: string): Promise<{defaultBranch: string}> {
    const defaultBranch = 'main'
    const branchKey = this.refKey(owner, repo, branch)
    if (!this.refs.has(branchKey)) {
      this.refs.add(branchKey)

      // Copy default branch files into the new branch to mimic git branching.
      const prefix = `${owner}/${repo}:${defaultBranch}:`
      for (const [key, value] of this.files.entries()) {
        if (!key.startsWith(prefix)) {
          continue
        }

        const filePath = key.slice(prefix.length)
        this.files.set(this.fileKey(owner, repo, branch, filePath), value)
      }
    }

    return {defaultBranch}
  }

  async readTextFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | undefined> {
    return this.files.get(this.fileKey(owner, repo, ref, filePath))
  }

  async upsertTextFile(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    content: string,
  ): Promise<{changed: boolean}> {
    const key = this.fileKey(owner, repo, branch, filePath)
    const previous = this.files.get(key)
    this.files.set(key, content)
    return {changed: previous !== content}
  }

  async upsertPullRequest(input: UpsertPullRequestInput): Promise<UpsertPullRequestResult> {
    const key = `${input.owner}/${input.repo}:${input.branch}`
    const existing = this.prs.get(key)
    if (existing) {
      existing.title = input.title
      existing.body = input.body
      return {number: existing.number, url: existing.url, created: false}
    }

    const number = this.nextPullNumber
    this.nextPullNumber += 1
    const url = `https://github.com/${input.owner}/${input.repo}/pull/${number}`
    this.prs.set(key, {
      number,
      url,
      title: input.title,
      body: input.body,
    })
    if (!this.lifecycles.has(url)) {
      this.lifecycles.set(url, 'opened')
    }

    return {number, url, created: true}
  }

  async getPullLifecycle(prUrl: string): Promise<PullLifecycle> {
    return this.lifecycles.get(prUrl) ?? 'blocked'
  }

  setPullLifecycle(prUrl: string, lifecycle: PullLifecycle): void {
    this.lifecycles.set(prUrl, lifecycle)
  }
}

interface WorkspaceFixture {
  root: string
  sourceRepoPath: string
}

function createWorkspaceFixture(
  indexRows: string[],
  contractDocs: Array<{id: string; body: string}>,
  mapRepos: string[],
): WorkspaceFixture {
  const root = mkTempDir()
  const sourceRepoPath = path.join(root, 'repos', 'spec-system')
  fs.mkdirSync(path.join(sourceRepoPath, 'docs', 'contracts'), {recursive: true})

  const index = [
    '---',
    'doc_type: contract_change_index',
    'version: 2.4.0',
    'last_synced: 2026-03-29',
    '---',
    '# Contract Changes Index',
    '',
    '| ID | Name | Status | Change Type | Owner | Path | Aliases |',
    '|----|------|--------|-------------|-------|------|---------|',
    ...indexRows,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(sourceRepoPath, 'docs', 'CONTRACT_CHANGES.md'), index, 'utf8')

  for (const contract of contractDocs) {
    fs.writeFileSync(path.join(sourceRepoPath, 'docs', 'contracts', `${contract.id}.md`), contract.body, 'utf8')
  }

  const project = initProject(root)
  const repos: RepoRecord[] = [
    {
      name: 'spec-system',
      fullName: 'acme/spec-system',
      org: 'acme',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      localPath: sourceRepoPath,
      source: 'hybrid',
    },
    {
      name: 'service-a',
      fullName: 'acme/service-a',
      org: 'acme',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      source: 'github',
    },
    {
      name: 'service-b',
      fullName: 'acme/service-b',
      org: 'acme',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      source: 'github',
    },
    {
      name: 'missing-spec',
      fullName: 'acme/missing-spec',
      org: 'acme',
      defaultBranch: 'main',
      archived: false,
      fork: false,
      source: 'github',
    },
  ]

  upsertRepos(project.db, repos)
  const scope = createScopeManifest('all-services', 'acme', mapRepos, root)
  saveScopeManifest(scope, root)
  project.db.close()
  return {root, sourceRepoPath}
}

function contractDocContent(
  id: string,
  status: 'approved' | 'published',
  targetRows: string[],
): string {
  return [
    '---',
    'doc_type: contract_change',
    `contract_change_id: ${id}`,
    `name: ${id} rollout`,
    `status: ${status}`,
    'change_type: api_contract_changed',
    'owner: platform',
    'last_updated: 2026-03-29',
    '---',
    `# ${id} rollout`,
    '',
    '## Summary',
    'Introduce a backwards-compatible contract.',
    '',
    '## Contract Surface',
    '- POST /v2/events',
    '',
    '## Change Details',
    'Adds optional fields.',
    '',
    '## Compatibility and Migration Guidance',
    'Support dual-write for one release cycle.',
    '',
    '## Downstream Notification Context',
    '| repo | owner | context | pr_url | state |',
    '|------|-------|---------|--------|-------|',
    ...targetRows,
    '',
  ].join('\n')
}

const EMPTY_SPEC_INDEX = [
  '---',
  'doc_type: contract_change_index',
  'version: 2.4.0',
  'last_synced: 2026-03-29',
  '---',
  '# Contract Changes Index',
  '',
  '| ID | Name | Status | Change Type | Owner | Path | Aliases |',
  '|----|------|--------|-------------|-------|------|---------|',
  '',
].join('\n')

describe('publish contracts workflows', () => {
  it('fails explicitly when source repo is missing spec-system contract index', async () => {
    const fixture = createWorkspaceFixture([], [], ['spec-system'])
    fs.rmSync(path.join(fixture.sourceRepoPath, 'docs', 'CONTRACT_CHANGES.md'))

    const project = initProject(fixture.root)
    await expect(
      publishNotices({
        db: project.db,
        mapId: 'all-services',
        sourceRepo: 'spec-system',
        noticeType: 'contract',
        dryRun: true,
        cwd: fixture.root,
      }),
    ).rejects.toThrow(/spec-system not instantiated/i)
    project.db.close()
  })

  it('creates target spec-system CC artifacts and fails fast when target spec-system is missing', async () => {
    const fixture = createWorkspaceFixture(
      ['| CC-101 | CC-101 rollout | approved | api_contract_changed | platform | contracts/CC-101.md | cc-101 |'],
      [
        {
          id: 'CC-101',
          body: contractDocContent('CC-101', 'approved', [
            '| service-a | team-a | migrate API client |  | pending |',
            '| missing-spec | team-b | update client |  | pending |',
            '| service-b | team-c | should not execute due fail-fast |  | pending |',
          ]),
        },
      ],
      ['spec-system', 'service-a', 'service-b', 'missing-spec'],
    )

    const githubOps = new MockGithubPublishOps()
    githubOps.seedFile('acme', 'service-a', 'main', 'docs/CONTRACT_CHANGES.md', EMPTY_SPEC_INDEX)
    githubOps.seedFile('acme', 'service-b', 'main', 'docs/CONTRACT_CHANGES.md', EMPTY_SPEC_INDEX)

    const project = initProject(fixture.root)
    const result = await publishNotices({
      db: project.db,
      mapId: 'all-services',
      sourceRepo: 'spec-system',
      noticeType: 'contract',
      githubOps,
      cwd: fixture.root,
    })

    expect(result.totals.created).toBe(1)
    expect(result.totals.failed).toBe(1)
    expect(result.failFastStoppedAt).toContain('spec-system not instantiated')

    const targetRows = result.contracts[0].targetResults
    expect(targetRows).toHaveLength(2)
    expect(targetRows[0].targetRepoInput).toBe('service-a')
    expect(targetRows[0].targetContractChangeId).toBe('CC-001')
    expect(targetRows[1].targetRepoInput).toBe('missing-spec')
    expect(targetRows[1].status).toBe('failed')

    expect(githubOps.getFile('acme', 'service-a', 'sdx/spec-notice/cc-101-service-a', 'docs/CONTRACT_CHANGES.md')).toContain(
      'CC-001',
    )
    expect(
      githubOps.getFile('acme', 'service-b', 'sdx/spec-notice/cc-101-service-b', 'docs/CONTRACT_CHANGES.md'),
    ).toBeUndefined()

    project.db.close()
  })

  it('is idempotent by updating existing target PR/artifacts on rerun', async () => {
    const fixture = createWorkspaceFixture(
      ['| CC-102 | CC-102 rollout | approved | api_contract_changed | platform | contracts/CC-102.md | cc-102 |'],
      [
        {
          id: 'CC-102',
          body: contractDocContent('CC-102', 'approved', ['| service-a | team-a | update API integration |  | pending |']),
        },
      ],
      ['spec-system', 'service-a'],
    )

    const githubOps = new MockGithubPublishOps()
    githubOps.seedFile('acme', 'service-a', 'main', 'docs/CONTRACT_CHANGES.md', EMPTY_SPEC_INDEX)

    const project = initProject(fixture.root)
    const first = await publishNotices({
      db: project.db,
      mapId: 'all-services',
      sourceRepo: 'spec-system',
      noticeType: 'contract',
      githubOps,
      cwd: fixture.root,
    })

    const second = await publishNotices({
      db: project.db,
      mapId: 'all-services',
      sourceRepo: 'spec-system',
      noticeType: 'contract',
      githubOps,
      cwd: fixture.root,
    })

    expect(first.totals.created).toBe(1)
    expect(second.totals.created).toBe(0)
    expect(second.totals.updated).toBe(1)
    expect(first.contracts[0].targetResults[0].targetContractChangeId).toBe('CC-001')
    expect(second.contracts[0].targetResults[0].targetContractChangeId).toBe('CC-001')

    project.db.close()
  })

  it('supports service mode by creating/updating a source CC from plan and publishing targets', async () => {
    const fixture = createWorkspaceFixture([], [], ['spec-system', 'service-a'])

    const planPath = path.join(fixture.root, 'plans', 'service-notice.md')
    fs.mkdirSync(path.dirname(planPath), {recursive: true})
    fs.writeFileSync(
      planPath,
      [
        '# New Service Notice',
        '',
        '## Service Identity',
        '- service_id: payments-orchestrator',
        '- name: Payments Orchestrator',
        '',
        '## Summary',
        'New orchestration service handling payment retries.',
        '',
        '## Contract Surface',
        '- POST /v1/payments/retry',
        '',
        '## Change Details',
        'Introduces idempotency token requirements.',
        '',
        '## Compatibility and Migration Guidance',
        'Clients should send idempotency tokens before cutover.',
        '',
        '## Target Repositories',
        '| repo | owner | context |',
        '|------|-------|---------|',
        '| service-a | mobile-team | update payment client |',
        '',
      ].join('\n'),
      'utf8',
    )

    const githubOps = new MockGithubPublishOps()
    githubOps.seedFile('acme', 'service-a', 'main', 'docs/CONTRACT_CHANGES.md', EMPTY_SPEC_INDEX)

    const project = initProject(fixture.root)
    const result = await publishNotices({
      db: project.db,
      mapId: 'all-services',
      sourceRepo: 'spec-system',
      noticeType: 'service',
      planPath,
      githubOps,
      cwd: fixture.root,
    })

    expect(result.noticeType).toBe('service')
    expect(result.contracts).toHaveLength(1)
    expect(result.contracts[0].contractChangeId).toBe('CC-001')
    expect(result.totals.created).toBe(1)
    expect(result.sourceSyncPrUrls).toHaveLength(1)

    project.db.close()
  })

  it('sync updates lifecycle states and closes source CC when all targets merge', async () => {
    const fixture = createWorkspaceFixture(
      ['| CC-303 | CC-303 rollout | published | api_contract_changed | platform | contracts/CC-303.md | cc-303 |'],
      [
        {
          id: 'CC-303',
          body: contractDocContent('CC-303', 'published', [
            '| service-a | team-a | update API integration | https://github.com/acme/service-a/pull/10 | opened |',
            '| service-b | team-b | update API integration | https://github.com/acme/service-b/pull/11 | opened |',
          ]),
        },
      ],
      ['spec-system', 'service-a', 'service-b'],
    )

    const githubOps = new MockGithubPublishOps()
    githubOps.setPullLifecycle('https://github.com/acme/service-a/pull/10', 'merged')
    githubOps.setPullLifecycle('https://github.com/acme/service-b/pull/11', 'merged')

    const project = initProject(fixture.root)
    const result = await publishSync({
      db: project.db,
      mapId: 'all-services',
      sourceRepo: 'spec-system',
      githubOps,
      cwd: fixture.root,
    })

    expect(result.totals.updated).toBe(2)
    expect(result.totals.failed).toBe(0)
    expect(result.contracts[0].sourceStatusBefore).toBe('published')
    expect(result.contracts[0].sourceStatusAfter).toBe('closed')

    project.db.close()
  })
})
