import path from 'node:path'
import {Args, Command, Flags} from '@oclif/core'
import {loadProject, recordRun, ensureMapDir} from '../../lib/project'
import {createScopeManifest, saveScopeManifest} from '../../lib/scope'
import {listReposByOrg} from '../../lib/repoRegistry'

export default class MapCreateCommand extends Command {
  static override description = 'Create a named service map scope from discovered repositories'

  static override flags = {
    org: Flags.string({char: 'o', required: true, description: 'GitHub organization to source repositories from'}),
  }

  static override args = {
    mapId: Args.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(MapCreateCommand)
    const context = loadProject(process.cwd())

    const repos = listReposByOrg(context.db, flags.org)
    if (repos.length === 0) {
      throw new Error(`No repositories found for org '${flags.org}'. Run 'sdx repo sync --org ${flags.org}' first.`)
    }

    ensureMapDir(args.mapId, context.cwd)

    const manifest = createScopeManifest(
      args.mapId,
      flags.org,
      repos.map((repo) => repo.name),
      context.cwd,
    )

    const archivedOrFork = repos.filter((repo) => repo.archived || repo.fork).map((repo) => repo.name)
    manifest.explicitExclude = [...new Set([...manifest.explicitExclude, ...archivedOrFork])].sort((a, b) => a.localeCompare(b))

    const scopePath = saveScopeManifest(manifest, context.cwd)

    const readmePath = path.join(path.dirname(scopePath), 'README.md')
    this.log(`Map created: ${args.mapId}`)
    this.log(`Scope manifest: ${scopePath}`)
    this.log(`Map directory: ${path.dirname(scopePath)}`)
    this.log(`Create notes in: ${readmePath}`)

    recordRun(context.db, 'map_create', 'ok', args.mapId, {org: flags.org, discovered: repos.length})
    context.db.close()
  }
}
