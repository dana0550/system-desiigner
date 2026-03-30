import {Command, Flags} from '@oclif/core'
import {checkFlow} from '../../lib/flow'
import {loadProject, recordRun} from '../../lib/project'

export default class FlowCheckCommand extends Command {
  static override description = 'CI-safe flow drift and integrity check (non-zero on risk-based failures)'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    env: Flags.string({
      required: false,
      options: ['dev', 'staging', 'prod', 'all'],
      default: 'all',
      description: 'Runtime evidence environment filter for check run',
    }),
    'runtime-dir': Flags.string({
      required: false,
      description: 'Override runtime evidence base directory (defaults to runtime/otel/<map-id>)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(FlowCheckCommand)
    const context = loadProject(process.cwd())

    const {result, checkPath} = checkFlow({
      mapId: flags.map,
      db: context.db,
      cwd: context.cwd,
      env: flags.env as 'dev' | 'staging' | 'prod' | 'all',
      runtimeDir: flags['runtime-dir'],
    })

    recordRun(context.db, 'flow_check', result.passed ? 'ok' : 'error', flags.map, {
      checkPath,
      env: flags.env,
      runtimeDir: flags['runtime-dir'],
      driftDetected: result.driftDetected,
      errors: result.errors,
      warnings: result.warnings,
      stats: result.stats,
    })

    context.db.close()

    this.log(`Flow check for map '${flags.map}': ${result.passed ? 'PASS' : 'FAIL'}`)
    this.log(`Drift detected: ${result.driftDetected ? 'yes' : 'no'}`)
    this.log(`Errors: ${result.errors.length}`)
    this.log(`Warnings: ${result.warnings.length}`)
    this.log(`Result JSON: ${checkPath}`)

    if (!result.passed) {
      this.error('Flow check failed. Resolve drift/findings and rerun.', {exit: 1})
    }
  }
}
