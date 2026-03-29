import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {validateArchitecture} from '../../lib/architecture'
import {writeJsonFile, writeTextFile} from '../../lib/fs'
import {loadProject, recordRun} from '../../lib/project'

export default class ArchitectureValidateCommand extends Command {
  static override description = 'Validate architecture model completeness and override integrity for a map'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ArchitectureValidateCommand)
    const context = loadProject(process.cwd())

    const result = validateArchitecture({
      mapId: flags.map,
      db: context.db,
      cwd: context.cwd,
    })

    const outDir = path.join(context.cwd, 'maps', flags.map, 'architecture')
    const jsonPath = path.join(outDir, 'validation.json')
    const mdPath = path.join(outDir, 'validation.md')

    writeJsonFile(jsonPath, result)

    const lines = [
      `# Architecture Validation: ${flags.map}`,
      '',
      `- Generated: ${result.generatedAt}`,
      `- Valid: ${result.valid ? 'yes' : 'no'}`,
      `- Errors: ${result.errors.length}`,
      `- Warnings: ${result.warnings.length}`,
      '',
    ]

    if (result.errors.length > 0) {
      lines.push('## Errors')
      lines.push('')
      for (const err of result.errors) {
        lines.push(`- ${err}`)
      }
      lines.push('')
    }

    if (result.warnings.length > 0) {
      lines.push('## Warnings')
      lines.push('')
      for (const warning of result.warnings) {
        lines.push(`- ${warning}`)
      }
      lines.push('')
    }

    writeTextFile(mdPath, `${lines.join('\n')}\n`)

    recordRun(context.db, 'architecture_validate', result.valid ? 'ok' : 'error', flags.map, {
      validationPath: jsonPath,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
      stats: result.stats,
    })

    context.db.close()

    this.log(`Validated architecture for map '${flags.map}'.`)
    this.log(`JSON: ${jsonPath}`)
    this.log(`Markdown: ${mdPath}`)
    this.log(`Result: ${result.valid ? 'pass' : 'fail'}`)

    if (!result.valid) {
      this.error('Architecture validation failed. Resolve errors and rerun.', {exit: 1})
    }
  }
}
