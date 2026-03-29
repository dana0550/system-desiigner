import fs from 'node:fs'
import path from 'node:path'
import {Command} from '@oclif/core'
import {loadProject} from '../lib/project'
import {fileExists} from '../lib/fs'

export default class StatusCommand extends Command {
  static override description = 'Show overall workspace status, map health, and recent outputs'

  async run(): Promise<void> {
    const context = loadProject(process.cwd())

    const repoCount = (context.db.prepare('SELECT COUNT(*) AS count FROM repo_registry').get() as {count: number}).count
    const runCount = (context.db.prepare('SELECT COUNT(*) AS count FROM run_log').get() as {count: number}).count

    this.log(`Initialized: yes`)
    this.log(`Repositories tracked: ${repoCount}`)
    this.log(`Runs logged: ${runCount}`)

    const mapsDir = path.join(context.cwd, 'maps')
    const mapIds = fs.existsSync(mapsDir)
      ? fs
          .readdirSync(mapsDir, {withFileTypes: true})
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : []

    this.log(`Maps: ${mapIds.length}`)
    for (const mapId of mapIds) {
      const mapDir = path.join(mapsDir, mapId)
      const hasScope = fileExists(path.join(mapDir, 'scope.json'))
      const hasServiceMap = fileExists(path.join(mapDir, 'service-map.json'))
      const hasArchitectureModel = fileExists(path.join(mapDir, 'architecture', 'model.json'))
      this.log(
        `- ${mapId}: scope=${hasScope ? 'yes' : 'no'}, service-map=${hasServiceMap ? 'yes' : 'no'}, architecture=${hasArchitectureModel ? 'yes' : 'no'}`,
      )
    }

    context.db.close()
  }
}
