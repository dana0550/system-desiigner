import {Command, Flags} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {validateFlow} from '../../lib/flow'

export default class FlowValidateCommand extends Command {
  static override description = 'Validate flow graph integrity and evidence quality for a map'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(FlowValidateCommand)
    const context = loadProject(process.cwd())

    const {validation, validationPath, validationMarkdownPath} = validateFlow({
      mapId: flags.map,
      db: context.db,
      cwd: context.cwd,
    })

    recordRun(context.db, 'flow_validate', validation.valid ? 'ok' : 'error', flags.map, {
      validationPath,
      validationMarkdownPath,
      errors: validation.errors.length,
      warnings: validation.warnings.length,
      stats: validation.stats,
    })

    context.db.close()

    this.log(`Flow validation for map '${flags.map}': ${validation.valid ? 'PASS' : 'FAIL'}`)
    this.log(`JSON: ${validationPath}`)
    this.log(`Markdown: ${validationMarkdownPath}`)
    this.log(`Errors: ${validation.errors.length}`)
    this.log(`Warnings: ${validation.warnings.length}`)

    if (!validation.valid) {
      this.error('Flow validation failed. Resolve flow findings and rerun.', {exit: 1})
    }
  }
}
