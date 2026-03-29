import {Command, Flags} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {generateDocsArtifacts} from '../../lib/workflows'

export default class DocsGenerateCommand extends Command {
  static override description = 'Generate architecture docs and dependency notes for a map'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DocsGenerateCommand)
    const context = loadProject(process.cwd())

    const result = generateDocsArtifacts(flags.map, context.db, context.cwd)
    recordRun(context.db, 'docs_generate', 'ok', flags.map, result)
    context.db.close()

    this.log(`Generated docs for map '${flags.map}'.`)
    this.log(`Architecture: ${result.architecturePath}`)
    this.log(`Dependencies: ${result.dependencyPath}`)
  }
}
