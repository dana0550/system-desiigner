import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {extractContracts} from '../../lib/contracts'
import {writeJsonFile, writeTextFile} from '../../lib/fs'
import {loadProject, recordRun} from '../../lib/project'
import {listAllRepos} from '../../lib/repoRegistry'
import {loadScopeManifest} from '../../lib/scope'
import {proposeService, renderServiceProposalMarkdown} from '../../lib/serviceProposal'

export default class ServiceProposeCommand extends Command {
  static override description = 'Draft a new service proposal based on map context and a brief file'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    brief: Flags.string({required: true, description: 'Path to service brief file'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ServiceProposeCommand)
    const context = loadProject(process.cwd())

    const scope = loadScopeManifest(flags.map, context.cwd)
    const repoMap = new Map(listAllRepos(context.db).map((repo) => [repo.name, repo]))
    const contracts = extractContracts(flags.map, scope, repoMap)

    const proposal = proposeService(flags.map, flags.brief, scope, contracts)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outJsonPath = path.join(context.cwd, 'plans', `${stamp}-${flags.map}-service-proposal.json`)
    const outMdPath = path.join(context.cwd, 'plans', `${stamp}-${flags.map}-service-proposal.md`)

    writeJsonFile(outJsonPath, proposal)
    writeTextFile(outMdPath, renderServiceProposalMarkdown(proposal))

    recordRun(context.db, 'service_propose', 'ok', flags.map, {
      proposalPath: outMdPath,
      serviceName: proposal.proposedServiceName,
    })
    context.db.close()

    this.log(`Service proposal written: ${outMdPath}`)
  }
}
