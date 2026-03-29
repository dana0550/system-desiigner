import {Args, Command, Flags} from '@oclif/core'
import {parsePromptIntent, renderPromptPreview} from '../lib/promptParser'
import {applyScopeChange, loadScopeManifest} from '../lib/scope'
import {buildMapArtifacts} from '../lib/workflows'
import {loadProject, recordRun} from '../lib/project'

export default class PromptCommand extends Command {
  static override description = 'Parse natural-language map instructions with preview and optional apply'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    apply: Flags.boolean({required: false, default: false, description: 'Apply the parsed action'}),
  }

  static override args = {
    instruction: Args.string({required: true, description: 'Natural language instruction'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(PromptCommand)
    const context = loadProject(process.cwd())
    const scope = loadScopeManifest(flags.map, context.cwd)
    const knownRepos = [...new Set([...scope.discovered, ...scope.explicitInclude, ...scope.explicitExclude])]

    const intent = parsePromptIntent(args.instruction, knownRepos)
    this.log(renderPromptPreview(intent))

    if (!flags.apply) {
      this.log('Preview only. Re-run with --apply to persist changes.')
      context.db.close()
      return
    }

    if (intent.action === 'include' || intent.action === 'exclude') {
      if (intent.repos.length === 0) {
        throw new Error('No known repositories were parsed from prompt. Use explicit map commands or mention exact repo names.')
      }

      const updated = applyScopeChange(
        flags.map,
        intent.action,
        intent.repos,
        `${intent.action} via prompt`,
        context.cwd,
      )

      recordRun(context.db, 'prompt_apply', 'ok', flags.map, {
        action: intent.action,
        repos: intent.repos,
        effectiveCount: updated.effective.length,
      })

      this.log(`Applied ${intent.action} to map '${flags.map}'.`)
      context.db.close()
      return
    }

    if (intent.action === 'build') {
      const result = buildMapArtifacts(flags.map, context.db, context.cwd)
      recordRun(context.db, 'prompt_build', 'ok', flags.map, result)
      this.log(`Built map '${flags.map}' via prompt.`)
      context.db.close()
      return
    }

    if (intent.action === 'status') {
      const scope = loadScopeManifest(flags.map, context.cwd)
      this.log(`Map ${scope.mapId}: effective=${scope.effective.length}, include=${scope.explicitInclude.length}, exclude=${scope.explicitExclude.length}`)
      recordRun(context.db, 'prompt_status', 'ok', flags.map)
      context.db.close()
      return
    }

    recordRun(context.db, 'prompt_unknown', 'error', flags.map, {instruction: args.instruction})
    context.db.close()
    throw new Error('Unable to determine a deterministic action from prompt. Use explicit map commands.')
  }
}
