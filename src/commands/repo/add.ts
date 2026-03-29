import fs from 'node:fs'
import {Command, Flags} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {setLocalRepoPath} from '../../lib/repoRegistry'

export default class RepoAddCommand extends Command {
  static override description = 'Register a local clone path for a repository'

  static override flags = {
    name: Flags.string({char: 'n', required: true, description: 'Repository name'}),
    path: Flags.string({char: 'p', required: true, description: 'Local path to repository clone'}),
    org: Flags.string({char: 'o', required: false, description: 'Organization override'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(RepoAddCommand)
    const context = loadProject(process.cwd())

    if (!fs.existsSync(flags.path)) {
      throw new Error(`Local path does not exist: ${flags.path}`)
    }

    const repo = setLocalRepoPath(context.db, flags.name, flags.path, flags.org ?? context.config.github.defaultOrg)
    recordRun(context.db, 'repo_add', 'ok', undefined, {name: repo.name, localPath: repo.localPath})

    context.db.close()
    this.log(`Registered local repo '${repo.name}' at ${repo.localPath}`)
  }
}
