import {Command} from '@oclif/core'
import {initProject} from '../lib/project'

export default class InitCommand extends Command {
  static override description = 'Initialize sdx config, database, and output directories'

  async run(): Promise<void> {
    const context = initProject(process.cwd())
    context.db.close()
    this.log('Initialized sdx workspace.')
    this.log(`Root: ${context.rootDir}`)
  }
}
