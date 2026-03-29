import {Args, Command} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {applyScopeChange} from '../../lib/scope'

export default class MapRemoveOverrideCommand extends Command {
  static override description = 'Remove include/exclude overrides for repositories in a map'

  static override args = {
    mapId: Args.string({required: true, description: 'Map identifier'}),
    repos: Args.string({required: true, multiple: true, description: 'Repository names (space- or comma-separated)'}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(MapRemoveOverrideCommand)
    const context = loadProject(process.cwd())

    const repos = args.repos
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter(Boolean)

    const updated = applyScopeChange(args.mapId, 'remove_override', repos, 'Override removed via CLI', context.cwd)
    recordRun(context.db, 'map_remove_override', 'ok', args.mapId, {repos})
    context.db.close()

    this.log(`Updated '${args.mapId}'. Effective repos: ${updated.effective.length}`)
  }
}
