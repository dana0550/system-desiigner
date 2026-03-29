import path from 'node:path'
import {Args, Command} from '@oclif/core'
import {writeJsonFile, writeTextFile} from '../../lib/fs'
import {buildServiceMapArtifact, renderServiceMapMarkdown, renderServiceMapMermaid} from '../../lib/mapBuilder'
import {loadProject, recordRun} from '../../lib/project'
import {listAllRepos} from '../../lib/repoRegistry'
import {loadScopeManifest, saveScopeManifest} from '../../lib/scope'

export default class MapBuildCommand extends Command {
  static override description = 'Generate map artifacts (markdown, mermaid, json) for a named map'

  static override args = {
    mapId: Args.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(MapBuildCommand)
    const context = loadProject(process.cwd())

    const scope = loadScopeManifest(args.mapId, context.cwd)
    saveScopeManifest(scope, context.cwd)

    const repoMap = new Map(listAllRepos(context.db).map((repo) => [repo.name, repo]))
    const artifact = buildServiceMapArtifact(args.mapId, scope, repoMap)

    const mapDir = path.join(context.cwd, 'maps', args.mapId)
    const jsonPath = path.join(mapDir, 'service-map.json')
    const mdPath = path.join(mapDir, 'service-map.md')
    const mmdPath = path.join(mapDir, 'service-map.mmd')

    writeJsonFile(jsonPath, artifact)
    writeTextFile(mdPath, renderServiceMapMarkdown(artifact))
    writeTextFile(mmdPath, renderServiceMapMermaid(artifact))

    recordRun(context.db, 'map_build', 'ok', args.mapId, {
      repos: artifact.repos.length,
      nodes: artifact.nodes.length,
      edges: artifact.edges.length,
    })

    context.db.close()

    this.log(`Built map '${args.mapId}'.`)
    this.log(`JSON: ${jsonPath}`)
    this.log(`Markdown: ${mdPath}`)
    this.log(`Mermaid: ${mmdPath}`)
  }
}
