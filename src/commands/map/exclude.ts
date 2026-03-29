import {Args, Command} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {applyScopeChange} from '../../lib/scope'

export default class MapExcludeCommand extends Command {
  static override description = 'Add repositories to explicit map exclude overrides'

  static override args = {
    mapId: Args.string({required: true, description: 'Map identifier'}),
    repos: Args.string({required: true, multiple: true, description: 'Repository names (space- or comma-separated)'}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(MapExcludeCommand)
    const context = loadProject(process.cwd())

    const repos = args.repos
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter(Boolean)

    const updated = applyScopeChange(args.mapId, 'exclude', repos, 'Manual exclude via CLI', context.cwd)
    recordRun(context.db, 'map_exclude', 'ok', args.mapId, {repos})
    context.db.close()

    this.log(`Updated '${args.mapId}'. Effective repos: ${updated.effective.length}`)
  }
}
