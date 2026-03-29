import {Command, Flags} from '@oclif/core'
import {loadProject, recordRun} from '../../lib/project'
import {publishSync} from '../../lib/publishContracts'

export default class PublishSyncCommand extends Command {
  static override description = 'Refresh downstream PR lifecycle state and sync source CC artifacts'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    'source-repo': Flags.string({
      required: true,
      description: 'Source repository name or owner/repo',
    }),
    'contract-change-id': Flags.string({
      required: false,
      description: 'Optional single contract change filter (example: CC-101)',
    }),
    'dry-run': Flags.boolean({
      default: false,
      description: 'Preview sync state transitions without writing source sync PRs',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PublishSyncCommand)
    const context = loadProject(process.cwd())
    const tokenEnv = context.config.github.tokenEnv
    const token = process.env[tokenEnv]

    if (!flags['dry-run'] && !token) {
      throw new Error(`Missing ${tokenEnv}. Set it before running publish sync.`)
    }

    const result = await publishSync({
      db: context.db,
      mapId: flags.map,
      sourceRepo: flags['source-repo'],
      contractChangeId: flags['contract-change-id'],
      dryRun: flags['dry-run'],
      githubToken: token,
      cwd: context.cwd,
    })

    const status = result.totals.failed > 0 ? 'error' : 'ok'
    recordRun(context.db, 'publish_sync', status, flags.map, {
      sourceRepo: result.sourceRepo,
      contractChangeId: result.contractChangeId,
      dryRun: result.dryRun,
      updated: result.totals.updated,
      skipped: result.totals.skipped,
      failed: result.totals.failed,
      sourceSyncPrUrls: result.sourceSyncPrUrls,
    })
    context.db.close()

    this.log(`Targets: updated=${result.totals.updated}, skipped=${result.totals.skipped}, failed=${result.totals.failed}`)
    for (const contract of result.contracts) {
      for (const target of contract.targetResults) {
        this.log(
          `${contract.contractChangeId} ${target.repo}: ${target.status} (${target.stateBefore} -> ${target.stateAfter})${target.prUrl ? ` ${target.prUrl}` : ''}${target.reason ? ` - ${target.reason}` : ''}`,
        )
      }
    }

    this.log(`Artifact JSON: ${result.artifactJsonPath}`)
    this.log(`Artifact Markdown: ${result.artifactMarkdownPath}`)
    if (result.sourceSyncPrUrls.length > 0) {
      this.log(`Source Sync PRs: ${result.sourceSyncPrUrls.join(', ')}`)
    }

    if (result.totals.failed > 0) {
      this.error(`publish sync completed with ${result.totals.failed} failed target(s).`, {exit: 1})
    }
  }
}
