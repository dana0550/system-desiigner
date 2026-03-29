import {Buffer} from 'node:buffer'

interface OctokitLike {
  rest: {
    repos: {
      get: (params: {owner: string; repo: string}) => Promise<{data: {default_branch: string}}>
      getBranch: (params: {owner: string; repo: string; branch: string}) => Promise<{data: {commit: {sha: string}}}>
      getContent: (params: {owner: string; repo: string; path: string; ref: string}) => Promise<{
        data: {type?: string; sha?: string; content?: string; encoding?: string} | Array<unknown>
      }>
      createOrUpdateFileContents: (params: {
        owner: string
        repo: string
        path: string
        branch: string
        message: string
        content: string
        sha?: string
      }) => Promise<unknown>
    }
    git: {
      getRef: (params: {owner: string; repo: string; ref: string}) => Promise<{data: {object: {sha: string}}}>
      createRef: (params: {owner: string; repo: string; ref: string; sha: string}) => Promise<unknown>
    }
    pulls: {
      list: (params: {owner: string; repo: string; state: 'open'; head: string}) => Promise<{data: Array<{number: number; html_url: string; title: string; body: string | null}>}>
      create: (params: {
        owner: string
        repo: string
        title: string
        body: string
        head: string
        base: string
        draft?: boolean
      }) => Promise<{data: {number: number; html_url: string}}>
      update: (params: {
        owner: string
        repo: string
        pull_number: number
        title?: string
        body?: string
      }) => Promise<{data: {number: number; html_url: string}}>
      get: (params: {owner: string; repo: string; pull_number: number}) => Promise<{
        data: {state: string; merged_at: string | null}
      }>
    }
  }
}

export type PullLifecycle = 'opened' | 'merged' | 'blocked'

export interface UpsertPullRequestInput {
  owner: string
  repo: string
  branch: string
  title: string
  body: string
  draft?: boolean
}

export interface UpsertPullRequestResult {
  number: number
  url: string
  created: boolean
}

export interface GithubPublishOps {
  ensureBranch(owner: string, repo: string, branch: string): Promise<{defaultBranch: string}>
  readTextFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | undefined>
  upsertTextFile(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    content: string,
    commitMessage: string,
  ): Promise<{changed: boolean}>
  upsertPullRequest(input: UpsertPullRequestInput): Promise<UpsertPullRequestResult>
  getPullLifecycle(prUrl: string): Promise<PullLifecycle>
}

function isNotFound(error: unknown): boolean {
  return Number((error as {status?: number}).status) === 404
}

function parsePrUrl(prUrl: string): {owner: string; repo: string; number: number} {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
  if (!match) {
    throw new Error(`Invalid PR URL: ${prUrl}`)
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  }
}

async function createOctokit(token: string): Promise<OctokitLike> {
  const {Octokit} = await import('@octokit/rest')
  return new Octokit({auth: token}) as unknown as OctokitLike
}

export function createGithubPublishOps(token: string): GithubPublishOps {
  const octokitPromise = createOctokit(token)

  return {
    async ensureBranch(owner: string, repo: string, branch: string): Promise<{defaultBranch: string}> {
      const octokit = await octokitPromise
      const repoData = await octokit.rest.repos.get({owner, repo})
      const defaultBranch = repoData.data.default_branch

      try {
        await octokit.rest.git.getRef({owner, repo, ref: `heads/${branch}`})
        return {defaultBranch}
      } catch (error) {
        if (!isNotFound(error)) {
          throw error
        }
      }

      const baseRef = await octokit.rest.git.getRef({owner, repo, ref: `heads/${defaultBranch}`})
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: baseRef.data.object.sha,
      })

      return {defaultBranch}
    },

    async upsertTextFile(
      owner: string,
      repo: string,
      branch: string,
      filePath: string,
      content: string,
      commitMessage: string,
    ): Promise<{changed: boolean}> {
      const octokit = await octokitPromise
      let existingSha: string | undefined
      let existingBody = ''

      try {
        const current = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: filePath,
          ref: branch,
        })

        if (!Array.isArray(current.data) && current.data.type === 'file') {
          existingSha = current.data.sha
          const encoded = current.data.content ?? ''
          existingBody = Buffer.from(encoded, current.data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
        }
      } catch (error) {
        if (!isNotFound(error)) {
          throw error
        }
      }

      if (existingBody === content) {
        return {changed: false}
      }

      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        branch,
        message: commitMessage,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha: existingSha,
      })

      return {changed: true}
    },

    async readTextFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | undefined> {
      const octokit = await octokitPromise
      try {
        const current = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: filePath,
          ref,
        })

        if (Array.isArray(current.data) || current.data.type !== 'file') {
          return undefined
        }

        const encoded = current.data.content ?? ''
        return Buffer.from(encoded, current.data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
      } catch (error) {
        if (isNotFound(error)) {
          return undefined
        }

        throw error
      }
    },

    async upsertPullRequest(input: UpsertPullRequestInput): Promise<UpsertPullRequestResult> {
      const octokit = await octokitPromise
      const {owner, repo, branch, title, body, draft} = input
      const repoData = await octokit.rest.repos.get({owner, repo})
      const base = repoData.data.default_branch
      const open = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${branch}`,
      })

      if (open.data.length > 0) {
        const existing = open.data[0]
        await octokit.rest.pulls.update({
          owner,
          repo,
          pull_number: existing.number,
          title,
          body,
        })

        return {
          number: existing.number,
          url: existing.html_url,
          created: false,
        }
      }

      const created = await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body,
        head: branch,
        base,
        draft,
      })

      return {
        number: created.data.number,
        url: created.data.html_url,
        created: true,
      }
    },

    async getPullLifecycle(prUrl: string): Promise<PullLifecycle> {
      const octokit = await octokitPromise
      const parsed = parsePrUrl(prUrl)
      const pull = await octokit.rest.pulls.get({
        owner: parsed.owner,
        repo: parsed.repo,
        pull_number: parsed.number,
      })

      if (pull.data.merged_at) {
        return 'merged'
      }

      return pull.data.state === 'open' ? 'opened' : 'blocked'
    },
  }
}
