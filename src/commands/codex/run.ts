import {Args, Command, Flags} from '@oclif/core'
import {runCodexTask} from '../../lib/codex'
import {loadProject, recordRun} from '../../lib/project'

export default class CodexRunCommand extends Command {
  static override description = 'Run Codex CLI with generated architecture context pack'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    input: Flags.string({required: false, description: 'Optional additional input file path'}),
  }

  static override args = {
    taskType: Args.string({required: true, description: 'Codex task type label'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(CodexRunCommand)
    const context = loadProject(process.cwd())

    const result = runCodexTask({
      mapId: flags.map,
      taskType: args.taskType,
      codexCommand: context.config.codex.cmd,
      inputFile: flags.input,
      cwd: context.cwd,
    })

    recordRun(context.db, 'codex_run', result.exitCode === 0 ? 'ok' : 'error', flags.map, result)
    context.db.close()

    this.log(`Codex run completed with exit code ${result.exitCode}.`)
    this.log(`Context pack: ${result.contextPackPath}`)
    this.log(`Prompt file: ${result.promptPath}`)
    this.log(`Run output: ${result.runMarkdownPath}`)

    if (result.exitCode !== 0) {
      throw new Error(`Codex run failed with non-zero exit code ${result.exitCode}. See ${result.runMarkdownPath}`)
    }
  }
}
