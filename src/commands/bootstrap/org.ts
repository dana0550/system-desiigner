import {Args, Command, Flags} from '@oclif/core'
import {createBootstrapStructure} from '../../lib/bootstrap'
import {loadProject, recordRun} from '../../lib/project'
import {saveConfig} from '../../lib/config'

export default class BootstrapOrgCommand extends Command {
  static override description = 'Bootstrap this repository as an org-level system design workspace'

  static override flags = {
    org: Flags.string({char: 'o', required: true, description: 'GitHub organization name'}),
    repo: Flags.string({char: 'r', required: true, description: 'Design repository name'}),
  }

  static override args = {
    target: Args.string({required: false, description: 'Optional reserved positional arg'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(BootstrapOrgCommand)
    const context = loadProject(process.cwd())

    createBootstrapStructure(flags.org, flags.repo, context.cwd)

    context.config.outputRepo.org = flags.org
    context.config.outputRepo.repo = flags.repo
    context.config.github.defaultOrg = flags.org
    saveConfig(context.config, context.cwd)

    recordRun(context.db, 'bootstrap_org', 'ok', undefined, {org: flags.org, repo: flags.repo})
    context.db.close()

    this.log(`Bootstrapped for org '${flags.org}' and design repo '${flags.repo}'.`)
  }
}
