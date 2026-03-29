import {Command, Flags} from '@oclif/core'
import {generateArchitecturePack} from '../../lib/architecture'
import {loadProject, recordRun} from '../../lib/project'
import {buildMapArtifacts, extractContractArtifacts, generateDocsArtifacts} from '../../lib/workflows'

export default class ArchitectureGenerateCommand extends Command {
  static override description = 'Generate architecture pack artifacts and diagrams for a map'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    depth: Flags.string({
      required: false,
      options: ['org', 'full'],
      default: 'full',
      description: 'Generation depth: org-only or full (org + per-service packs)',
    }),
    service: Flags.string({
      required: false,
      description: 'Generate only one service deep-dive (service id/repo name)',
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(ArchitectureGenerateCommand)
    if (flags.depth === 'org' && flags.service) {
      throw new Error('Cannot use --service with --depth org. Use --depth full for targeted service generation.')
    }

    const context = loadProject(process.cwd())
    const mapArtifacts = buildMapArtifacts(flags.map, context.db, context.cwd)
    const contractArtifacts = extractContractArtifacts(flags.map, context.db, context.cwd)
    const docsArtifacts = generateDocsArtifacts(flags.map, context.db, context.cwd)

    const result = generateArchitecturePack({
      mapId: flags.map,
      db: context.db,
      cwd: context.cwd,
      depth: flags.depth as 'org' | 'full',
      serviceId: flags.service,
    })

    recordRun(context.db, 'architecture_generate', result.validation.valid ? 'ok' : 'error', flags.map, {
      depth: flags.depth,
      service: flags.service,
      generatedServices: result.generatedServices.length,
      validation: result.validation,
      modelPath: result.modelPath,
      indexDocPath: result.indexDocPath,
      baseline: {
        mapArtifacts,
        contractArtifacts,
        docsArtifacts,
      },
    })

    context.db.close()

    this.log(`Generated architecture pack for map '${flags.map}'.`)
    this.log(`Model: ${result.modelPath}`)
    this.log(`Overrides: ${result.overridesPath}`)
    this.log(`Baseline service map: ${result.baselineArtifacts.serviceMapPath}`)
    this.log(`Baseline contracts: ${result.baselineArtifacts.contractsPath}`)
    this.log(`Baseline architecture doc: ${result.baselineArtifacts.architectureDocPath}`)
    if (result.indexDocPath) {
      this.log(`Architecture index: ${result.indexDocPath}`)
    }

    if (result.generatedServices.length > 0) {
      this.log(`Service deep dives: ${result.generatedServices.length}`)
    }

    this.log(
      `Validation: ${result.validation.valid ? 'pass' : 'fail'} (errors=${result.validation.errors.length}, warnings=${result.validation.warnings.length})`,
    )

    if (!result.validation.valid) {
      this.error('Architecture validation failed. Resolve override/model issues and rerun.', {exit: 1})
    }
  }
}
