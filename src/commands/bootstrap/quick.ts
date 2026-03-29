import {Args, Command, Flags} from '@oclif/core'
import {bootstrapConsumer, ConsumerBootstrapMode} from '../../lib/bootstrapConsumer'
import {parseBootstrapQuickTarget} from '../../lib/bootstrapQuick'

export default class BootstrapQuickCommand extends Command {
  static override description = 'One-command bootstrap for a consumer workspace'

  static override examples = [
    '<%= config.bin %> <%= command.id %> dana0550',
    '<%= config.bin %> <%= command.id %> dana0550/dana0550-system-designer --seed',
  ]

  static override args = {
    target: Args.string({
      required: true,
      description: 'GitHub org or org/design-repo target',
    }),
  }

  static override flags = {
    inPlace: Flags.boolean({
      default: false,
      aliases: ['in-place'],
      description: 'Initialize in the current directory instead of creating ./<design-repo>',
    }),
    dir: Flags.string({
      required: false,
      description: 'Optional target directory override',
    }),
    pin: Flags.string({
      required: false,
      description: 'Optional pinned sdx-cli version for scripts/sdx wrapper',
    }),
    seed: Flags.boolean({
      default: false,
      description: 'Seed all-services map after bootstrap (requires GITHUB_TOKEN)',
    }),
    createRemote: Flags.boolean({
      default: false,
      aliases: ['create-remote'],
      description: 'Create remote design repo in GitHub (dedicated mode only)',
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(BootstrapQuickCommand)
    const target = parseBootstrapQuickTarget(args.target)
    const mode: ConsumerBootstrapMode = flags.inPlace ? 'in-place' : 'dedicated'

    const result = await bootstrapConsumer({
      org: target.org,
      designRepo: target.designRepo,
      mode,
      targetDir: flags.dir,
      pin: flags.pin,
      seedDefaultMap: flags.seed,
      createRemote: flags.createRemote,
      cwd: process.cwd(),
    })

    this.log('Bootstrap complete.')
    this.log(`Design repo: ${target.designRepo}`)
    this.log(`Workspace: ${result.targetDir}`)
    this.log(`Pinned version: ${result.pinnedVersion}`)
    this.log(`Wrapper: ${result.targetDir}/scripts/sdx`)
    this.log('')
    this.log('Start here:')
    this.log(`- cd ${result.targetDir}`)
    this.log('- ./scripts/sdx status')
    this.log('- ./scripts/sdx repo sync --org <org>')

    if (result.seededDefaultMap) {
      this.log('- ./scripts/sdx map status all-services')
    } else {
      this.log('- ./scripts/sdx map create all-services --org <org>')
      this.log('- ./scripts/sdx map build all-services')
    }
    this.log('- ./scripts/sdx architecture generate --map all-services')

    if (result.warnings.length > 0) {
      this.log('')
      this.log('Warnings:')
      for (const warning of result.warnings) {
        this.log(`- ${warning}`)
      }
    }
  }
}
