import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {extractContracts} from '../../lib/contracts'
import {writeJsonFile, writeTextFile} from '../../lib/fs'
import {buildHandoff, renderHandoffMarkdown} from '../../lib/handoff'
import {loadProject, recordRun} from '../../lib/project'
import {listAllRepos} from '../../lib/repoRegistry'
import {loadScopeManifest} from '../../lib/scope'

export default class HandoffDraftCommand extends Command {
  static override description = 'Generate per-repository handoff integration drafts for a new service'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    service: Flags.string({required: true, description: 'New service identifier'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(HandoffDraftCommand)
    const context = loadProject(process.cwd())

    const scope = loadScopeManifest(flags.map, context.cwd)
    const repoMap = new Map(listAllRepos(context.db).map((repo) => [repo.name, repo]))
    const contracts = extractContracts(flags.map, scope, repoMap)

    const handoff = buildHandoff(flags.map, flags.service, scope, contracts)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outJsonPath = path.join(context.cwd, 'handoffs', `${stamp}-${flags.map}-${flags.service}.json`)
    const outMdPath = path.join(context.cwd, 'handoffs', `${stamp}-${flags.map}-${flags.service}.md`)

    writeJsonFile(outJsonPath, handoff)
    writeTextFile(outMdPath, renderHandoffMarkdown(handoff))

    recordRun(context.db, 'handoff_draft', 'ok', flags.map, {
      service: flags.service,
      targets: handoff.targets.length,
      output: outMdPath,
    })

    context.db.close()

    this.log(`Handoff draft generated: ${outMdPath}`)
  }
}
