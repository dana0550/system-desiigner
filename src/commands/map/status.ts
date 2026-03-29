import {Args, Command} from '@oclif/core'
import {loadProject} from '../../lib/project'
import {loadScopeManifest} from '../../lib/scope'

export default class MapStatusCommand extends Command {
  static override description = 'Show current map scope and overrides'

  static override args = {
    mapId: Args.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(MapStatusCommand)
    const context = loadProject(process.cwd())

    const scope = loadScopeManifest(args.mapId, context.cwd)
    context.db.close()

    this.log(`Map: ${scope.mapId}`)
    this.log(`Org: ${scope.org}`)
    this.log(`Discovered: ${scope.discovered.length}`)
    this.log(`Explicit include: ${scope.explicitInclude.length}`)
    this.log(`Explicit exclude: ${scope.explicitExclude.length}`)
    this.log(`Effective: ${scope.effective.length}`)

    if (scope.explicitInclude.length > 0) {
      this.log(`Include overrides: ${scope.explicitInclude.join(', ')}`)
    }

    if (scope.explicitExclude.length > 0) {
      this.log(`Exclude overrides: ${scope.explicitExclude.join(', ')}`)
    }
  }
}
