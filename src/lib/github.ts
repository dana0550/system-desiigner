import {RepoRecord} from './types'

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
