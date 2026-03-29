import {Args, Command} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {applyScopeChange} from '../../lib/scope'

export default class MapIncludeCommand extends Command {
  static override description = 'Add repositories to explicit map include overrides'

  static override args = {
    mapId: Args.string({required: true, description: 'Map identifier'}),
    repos: Args.string({required: true, multiple: true, description: 'Repository names (space- or comma-separated)'}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(MapIncludeCommand)
    const context = loadProject(process.cwd())

    const repos = args.repos
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter(Boolean)

    const updated = applyScopeChange(args.mapId, 'include', repos, 'Manual include via CLI', context.cwd)
    recordRun(context.db, 'map_include', 'ok', args.mapId, {repos})
    context.db.close()

    this.log(`Updated '${args.mapId}'. Effective repos: ${updated.effective.length}`)
  }
}
