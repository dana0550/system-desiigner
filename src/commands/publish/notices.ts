import {Command, Flags} from '@oclif/core'
import {publishNotices} from '../../lib/publishContracts'
import {loadProject, recordRun} from '../../lib/project'

export default class PublishNoticesCommand extends Command {
  static override description = 'Publish cross-repo spec-system Contract Change PRs to target repositories'

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
      description: 'Preview actions without writing branches, files, or PRs',
    }),
    'max-targets': Flags.integer({
      required: false,
      description: 'Maximum number of pending targets to publish in this run',
    }),
    'notice-type': Flags.string({
      required: false,
      default: 'contract',
      options: ['contract', 'service'],
      description: 'Notice generation mode',
    }),
    plan: Flags.string({
      required: false,
      description: 'Required for --notice-type service. Path to structured service plan markdown.',
    }),
    ready: Flags.boolean({
      default: false,
      description: 'Create ready PRs instead of draft PRs',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PublishNoticesCommand)
    const context = loadProject(process.cwd())
    const tokenEnv = context.config.github.tokenEnv
    const token = process.env[tokenEnv]

    if (!flags['dry-run'] && !token) {
      throw new Error(`Missing ${tokenEnv}. Set it before running publish notices.`)
    }

    if (flags['notice-type'] === 'service' && !flags.plan) {
      throw new Error('`--plan <file>` is required when --notice-type service is used.')
    }

    const result = await publishNotices({
      db: context.db,
      mapId: flags.map,
      sourceRepo: flags['source-repo'],
      contractChangeId: flags['contract-change-id'],
      dryRun: flags['dry-run'],
      maxTargets: flags['max-targets'],
      noticeType: flags['notice-type'] as 'contract' | 'service',
      planPath: flags.plan,
      ready: flags.ready,
      githubToken: token,
      cwd: context.cwd,
    })

    const status = result.totals.failed > 0 ? 'error' : 'ok'
    recordRun(context.db, 'publish_notices', status, flags.map, {
      sourceRepo: result.sourceRepo,
      contractChangeId: result.contractChangeId,
      noticeType: result.noticeType,
      planPath: result.planPath,
      dryRun: result.dryRun,
      created: result.totals.created,
      updated: result.totals.updated,
      skipped: result.totals.skipped,
      failed: result.totals.failed,
      sourceSyncPrUrls: result.sourceSyncPrUrls,
    })
    context.db.close()

    this.log(
      `Mode=${result.noticeType} Targets: created=${result.totals.created}, updated=${result.totals.updated}, skipped=${result.totals.skipped}, failed=${result.totals.failed}`,
    )
    for (const contract of result.contracts) {
      for (const target of contract.targetResults) {
        this.log(
          `${contract.contractChangeId} ${target.targetRepoInput}: ${target.status} (${target.stateBefore} -> ${target.stateAfter})${target.prUrl ? ` ${target.prUrl}` : ''}${target.reason ? ` - ${target.reason}` : ''}`,
        )
      }
    }

    this.log(`Artifact JSON: ${result.artifactJsonPath}`)
    this.log(`Artifact Markdown: ${result.artifactMarkdownPath}`)
    if (result.failFastStoppedAt) {
      this.log(`Fail-fast stop: ${result.failFastStoppedAt}`)
    }
    if (result.sourceSyncPrUrls.length > 0) {
      this.log(`Source Sync PRs: ${result.sourceSyncPrUrls.join(', ')}`)
    }

    if (result.totals.failed > 0) {
      this.error(`publish notices completed with ${result.totals.failed} failed target(s).`, {exit: 1})
    }
  }
}
