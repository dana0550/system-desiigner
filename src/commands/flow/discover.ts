import {Command, Flags} from '@oclif/core'
import {discoverFlow} from '../../lib/flow'
import {loadProject, recordRun} from '../../lib/project'

export default class FlowDiscoverCommand extends Command {
  static override description = 'Discover endpoint-level flow graph and evidence-backed findings for a map'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    env: Flags.string({
      required: false,
      options: ['dev', 'staging', 'prod', 'all'],
      default: 'all',
      description: 'Runtime evidence environment filter',
    }),
    'runtime-dir': Flags.string({
      required: false,
      description: 'Override runtime evidence base directory (defaults to runtime/otel/<map-id>)',
    }),
    'dry-run': Flags.boolean({
      required: false,
      default: false,
      description: 'Discover and print summary without writing flow artifacts',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(FlowDiscoverCommand)
    const context = loadProject(process.cwd())

    const result = discoverFlow({
      mapId: flags.map,
      db: context.db,
      cwd: context.cwd,
      env: flags.env as 'dev' | 'staging' | 'prod' | 'all',
      runtimeDir: flags['runtime-dir'],
      dryRun: flags['dry-run'],
    })

    const errorCount = result.findings.findings.filter((finding) => finding.severity === 'error').length
    const warningCount = result.findings.findings.filter((finding) => finding.severity === 'warning').length

    recordRun(context.db, 'flow_discover', errorCount > 0 ? 'error' : 'ok', flags.map, {
      dryRun: flags['dry-run'],
      env: flags.env,
      runtimeDir: flags['runtime-dir'],
      graphPath: result.graphPath,
      endpointsPath: result.endpointsPath,
      findingsPath: result.findingsPath,
      journeysPath: result.journeysPath,
      nodeCount: result.graph.nodes.length,
      edgeCount: result.graph.edges.length,
      endpointCount: result.endpoints.length,
      findings: {
        errors: errorCount,
        warnings: warningCount,
      },
    })

    context.db.close()

    this.log(`Flow discovery completed for map '${flags.map}'.`)
    this.log(`Nodes: ${result.graph.nodes.length}`)
    this.log(`Edges: ${result.graph.edges.length}`)
    this.log(`Endpoints: ${result.endpoints.length}`)
    this.log(`Findings: errors=${errorCount}, warnings=${warningCount}`)

    if (!flags['dry-run']) {
      this.log(`Graph: ${result.graphPath}`)
      this.log(`Endpoints: ${result.endpointsPath}`)
      this.log(`Findings: ${result.findingsPath}`)
      this.log(`Journeys: ${result.journeysPath}`)
    }
  }
}
