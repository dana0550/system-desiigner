import {RepoRecord} from './types'

export interface RepositoryMarkdownDoc {
  path: string
  body: string
  referenceUrl: string
}

export async function fetchOrgRepos(org: string, token: string): Promise<RepoRecord[]> {
  const {Octokit} = await import('@octokit/rest')
  const octokit = new Octokit({auth: token})
  const now = new Date().toISOString()

  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org,
    per_page: 100,
    type: 'all',
  })

  return repos.map((repo) => ({
    name: repo.name,
    fullName: repo.full_name,
    org,
    defaultBranch: repo.default_branch,
    archived: Boolean(repo.archived),
    fork: Boolean(repo.fork),
    htmlUrl: repo.html_url,
    source: 'github' as const,
    lastSyncedAt: now,
  }))
}

export async function ensureOrgRepo(
  org: string,
  repoName: string,
  token: string,
): Promise<{created: boolean; htmlUrl?: string}> {
  const {Octokit} = await import('@octokit/rest')
  const octokit = new Octokit({auth: token})

  try {
    const existing = await octokit.rest.repos.get({owner: org, repo: repoName})
    return {
      created: false,
      htmlUrl: existing.data.html_url ?? undefined,
    }
  } catch (error) {
    const status = Number((error as {status?: number}).status)
    if (status !== 404) {
      throw error
    }
  }

  const created = await octokit.rest.repos.createInOrg({
    org,
    name: repoName,
    private: true,
    auto_init: false,
  })

  return {
    created: true,
    htmlUrl: created.data.html_url ?? undefined,
  }
}

function markdownPathPriority(filePath: string): number {
  const lower = filePath.toLowerCase()
  if (lower === 'readme.md' || lower.endsWith('/readme.md') || lower.endsWith('/readme.mdx')) {
    return 0
  }

  if (lower.includes('/docs/architecture/') || lower.includes('/architecture/')) {
    return 1
  }

  if (lower.includes('/docs/api/') || lower.includes('/api/')) {
    return 2
  }

  if (lower.includes('/docs/')) {
    return 3
  }

  return 4
}

function isIgnoredPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return (
    lower.includes('/node_modules/') ||
    lower.includes('/dist/') ||
    lower.includes('/build/') ||
    lower.includes('/.next/') ||
    lower.includes('/coverage/') ||
    lower.includes('/vendor/')
  )
}

function toBlobUrl(owner: string, repo: string, branch: string, filePath: string): string {
  const encodedPath = filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${encodedPath}`
}

export async function fetchRepositoryMarkdownDocs(options: {
  owner: string
  repo: string
  defaultBranch: string
  token: string
  maxFiles?: number
  maxBytesPerFile?: number
}): Promise<RepositoryMarkdownDoc[]> {
  const {Octokit} = await import('@octokit/rest')
  const octokit = new Octokit({auth: options.token})

  const maxFiles = options.maxFiles ?? 30
  const maxBytesPerFile = options.maxBytesPerFile ?? 120_000

  const tree = await octokit.rest.git.getTree({
    owner: options.owner,
    repo: options.repo,
    tree_sha: options.defaultBranch,
    recursive: 'true',
  })

  const markdownFiles = (tree.data.tree ?? [])
    .filter((entry) => Boolean(entry.path && entry.type))
    .map((entry) => ({path: entry.path as string, type: entry.type as string}))
    .filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path)
    .filter((filePath) => /\.(md|mdx)$/i.test(filePath))
    .filter((filePath) => !isIgnoredPath(filePath))
    .sort((a, b) => {
      const priorityDelta = markdownPathPriority(a) - markdownPathPriority(b)
      if (priorityDelta !== 0) {
        return priorityDelta
      }
      return a.localeCompare(b)
    })
    .slice(0, maxFiles)

  const docs: RepositoryMarkdownDoc[] = []

  for (const filePath of markdownFiles) {
    const response = await octokit.rest.repos.getContent({
      owner: options.owner,
      repo: options.repo,
      path: filePath,
      ref: options.defaultBranch,
    })

    if (Array.isArray(response.data) || response.data.type !== 'file' || !response.data.content) {
      continue
    }

    const raw = Buffer.from(response.data.content, 'base64').toString('utf8')
    const body = raw.slice(0, maxBytesPerFile)
    if (body.trim().length === 0) {
      continue
    }

    docs.push({
      path: filePath,
      body,
      referenceUrl: toBlobUrl(options.owner, options.repo, options.defaultBranch, filePath),
    })
  }

  return docs
}
