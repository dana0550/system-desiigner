import {Command, Flags} from '@oclif/core'
import {fetchOrgRepos} from '../../lib/github'
import {loadProject, recordRun} from '../../lib/project'
import {upsertRepos} from '../../lib/repoRegistry'

export default class RepoSyncCommand extends Command {
  static override description = 'Sync repository inventory from a GitHub organization'

  static override flags = {
    org: Flags.string({char: 'o', required: false, description: 'GitHub org (defaults to config.github.defaultOrg)'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(RepoSyncCommand)
    const context = loadProject(process.cwd())

    const org = flags.org ?? context.config.github.defaultOrg
    if (!org) {
      throw new Error('No organization provided. Use --org or set one via `sdx bootstrap org`.')
    }

    const token = process.env[context.config.github.tokenEnv]
    if (!token) {
      throw new Error(`Missing GitHub token. Set ${context.config.github.tokenEnv}.`)
    }

    const repos = await fetchOrgRepos(org, token)
    upsertRepos(context.db, repos)
    recordRun(context.db, 'repo_sync', 'ok', undefined, {org, count: repos.length})

    context.db.close()
    this.log(`Synced ${repos.length} repositories for org '${org}'.`)
  }
}
