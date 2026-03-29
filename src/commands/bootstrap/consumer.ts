import {Command, Flags} from '@oclif/core'
import {bootstrapConsumer, ConsumerBootstrapMode} from '../../lib/bootstrapConsumer'

export default class BootstrapConsumerCommand extends Command {
  static override description = 'Initialize an sdx workspace for use in another org/repository'

  static override flags = {
    org: Flags.string({char: 'o', required: true, description: 'GitHub organization name'}),
    designRepo: Flags.string({
      required: true,
      aliases: ['design-repo'],
      description: 'Design repository name for this sdx instance',
    }),
    mode: Flags.string({
      options: ['dedicated', 'in-place'],
      default: 'dedicated',
      description: 'Bootstrap mode (default dedicated repo, optional in-place repo initialization)',
    }),
    targetDir: Flags.string({
      required: false,
      aliases: ['target-dir'],
      description: 'Optional target directory (default: ./<design-repo> for dedicated, . for in-place)',
    }),
    pin: Flags.string({
      required: false,
      description: 'Pin wrapper script to a specific sdx-cli version (defaults to current CLI package version)',
    }),
    seedDefaultMap: Flags.boolean({
      default: false,
      aliases: ['seed-default-map'],
      description: 'Seed all-services map by running repo sync + map create + map build',
    }),
    createRemote: Flags.boolean({
      default: false,
      aliases: ['create-remote'],
      description: 'Create the remote design repository in GitHub (dedicated mode only)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(BootstrapConsumerCommand)

    const result = await bootstrapConsumer({
      org: flags.org,
      designRepo: flags.designRepo,
      mode: flags.mode as ConsumerBootstrapMode,
      targetDir: flags.targetDir,
      pin: flags.pin,
      seedDefaultMap: flags.seedDefaultMap,
      createRemote: flags.createRemote,
      cwd: process.cwd(),
    })

    this.log(`Consumer bootstrap complete.`)
    this.log(`Target directory: ${result.targetDir}`)
    this.log(`Mode: ${result.mode}`)
    this.log(`Pinned CLI version: ${result.pinnedVersion}`)

    if (result.remoteUrl) {
      this.log(`Remote repository: ${result.remoteUrl} (${result.remoteCreated ? 'created' : 'already existed'})`)
    }

    if (result.seededDefaultMap) {
      this.log(`Seeded map: all-services`)
    }

    if (result.warnings.length > 0) {
      this.log('Warnings:')
      for (const warning of result.warnings) {
        this.log(`- ${warning}`)
      }
    }

    if (result.nextSteps.length > 0) {
      this.log('Next steps:')
      for (const step of result.nextSteps) {
        this.log(`- ${step}`)
      }
    }
  }
}
