import {Command, Flags} from '@oclif/core'
import {generateFlowDiagrams} from '../../lib/flow'
import {loadProject, recordRun} from '../../lib/project'

export default class FlowDiagramCommand extends Command {
  static override description = 'Generate flow diagrams (service communication, client/backend, event lineage, journeys)'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    journey: Flags.string({required: false, description: 'Journey name or journey id to render'}),
    output: Flags.string({required: false, description: 'Output directory override for diagrams'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(FlowDiagramCommand)
    const context = loadProject(process.cwd())

    const result = generateFlowDiagrams({
      mapId: flags.map,
      cwd: context.cwd,
      journey: flags.journey,
      outputDir: flags.output,
    })

    recordRun(context.db, 'flow_diagram', 'ok', flags.map, {
      journey: flags.journey,
      outputDir: result.outputDir,
      endpointCommunicationPath: result.endpointCommunicationPath,
      clientBackendPath: result.clientBackendPath,
      eventLineagePath: result.eventLineagePath,
      journeyPaths: result.journeyPaths,
    })

    context.db.close()

    this.log(`Flow diagrams generated for map '${flags.map}'.`)
    this.log(`Output directory: ${result.outputDir}`)
    this.log(`Endpoint communication: ${result.endpointCommunicationPath}`)
    this.log(`Client/backend: ${result.clientBackendPath}`)
    this.log(`Event/data lineage: ${result.eventLineagePath}`)
    this.log(`Journey diagrams: ${result.journeyPaths.length}`)
    for (const filePath of result.journeyPaths) {
      this.log(`- ${filePath}`)
    }
  }
}
