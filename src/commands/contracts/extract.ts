import {Command, Flags} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {extractContractArtifacts} from '../../lib/workflows'

export default class ContractsExtractCommand extends Command {
  static override description = 'Extract and catalog API/event contracts for a map scope'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ContractsExtractCommand)
    const context = loadProject(process.cwd())

    const result = extractContractArtifacts(flags.map, context.db, context.cwd)
    recordRun(context.db, 'contracts_extract', 'ok', flags.map, {count: result.count})
    context.db.close()

    this.log(`Extracted ${result.count} contracts for map '${flags.map}'.`)
    this.log(`JSON: ${result.jsonPath}`)
    this.log(`Markdown: ${result.markdownPath}`)
  }
}
