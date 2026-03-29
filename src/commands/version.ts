import {Command} from '@oclif/core'
import pkg from '../../package.json'
import {SCHEMA_VERSION} from '../lib/constants'

export default class VersionCommand extends Command {
  static override description = 'Show CLI and artifact schema versions'

  async run(): Promise<void> {
    this.log(`sdx-cli: ${pkg.version}`)
    this.log(`artifact-schema: ${SCHEMA_VERSION}`)
  }
}
