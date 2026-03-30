import {Command, Flags} from '@oclif/core'
import {generateReadme, parseReadmeSectionList} from '../../lib/readme'
import {loadProject, recordRun} from '../../lib/project'

export default class DocsReadmeCommand extends Command {
  static override description = 'Generate or validate the canonical root README from SDX artifacts'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    output: Flags.string({required: false, default: 'README.md', description: 'README output path'}),
    check: Flags.boolean({required: false, default: false, description: 'Check mode (no writes, non-zero on stale/missing/diff)'}),
    'dry-run': Flags.boolean({required: false, default: false, description: 'Preview mode (no writes, print unified diff + summary)'}),
    include: Flags.string({
      required: false,
      description: 'Comma-separated section IDs to include (baseline order preserved)',
    }),
    exclude: Flags.string({
      required: false,
      description: 'Comma-separated section IDs to exclude (applied after include; exclude wins)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(DocsReadmeCommand)
    const context = loadProject(process.cwd())

    const includeSections = parseReadmeSectionList(flags.include)
    const excludeSections = parseReadmeSectionList(flags.exclude)

    const result = await generateReadme({
      mapId: flags.map,
      db: context.db,
      cwd: context.cwd,
      output: flags.output,
      includeSections,
      excludeSections,
      check: flags.check,
      dryRun: flags['dry-run'],
    })

    const status: 'ok' | 'error' = result.checkPassed ? 'ok' : 'error'
    recordRun(context.db, 'docs_readme', status, flags.map, {
      outputPath: result.outputPath,
      sections: result.sections,
      changed: result.changed,
      stale: result.stale,
      staleSources: result.staleSources.map((source) => source.label),
      missingSources: result.missingSources.map((source) => source.label),
      dryRun: flags['dry-run'],
      check: flags.check,
    })

    context.db.close()

    this.log(result.summary)

    if (result.diff && result.diff.trim().length > 0) {
      this.log('')
      this.log(result.diff.trimEnd())
    }

    if (flags.check && !result.checkPassed) {
      this.error('README check failed: stale/missing sources or content drift detected.', {exit: 1})
    }

    if (!flags.check && !flags['dry-run']) {
      this.log(`Wrote README: ${result.outputPath}`)
    }
  }
}
