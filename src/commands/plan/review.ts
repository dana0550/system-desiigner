import path from 'node:path'
import {Args, Command, Flags} from '@oclif/core'
import {fileExists, readJsonFile, writeJsonFile, writeTextFile} from '../../lib/fs'
import {buildServiceMapArtifact} from '../../lib/mapBuilder'
import {reviewPlan, renderPlanReviewMarkdown} from '../../lib/planReview'
import {loadProject, recordRun} from '../../lib/project'
import {listAllRepos} from '../../lib/repoRegistry'
import {loadScopeManifest} from '../../lib/scope'
import {ServiceMapArtifact} from '../../lib/types'

export default class PlanReviewCommand extends Command {
  static override description = 'Review a proposed service plan against current architecture'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
    plan: Flags.string({required: true, description: 'Path to plan file (markdown or text)'}),
  }

  static override args = {
    target: Args.string({required: false, description: 'Reserved positional arg'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PlanReviewCommand)
    const context = loadProject(process.cwd())

    const scope = loadScopeManifest(flags.map, context.cwd)
    const repoMap = new Map(listAllRepos(context.db).map((repo) => [repo.name, repo]))

    const mapPath = path.join(context.cwd, 'maps', flags.map, 'service-map.json')
    const fallbackMap = buildServiceMapArtifact(flags.map, scope, repoMap)
    let selectedMap: ServiceMapArtifact = fallbackMap
    if (fileExists(mapPath)) {
      try {
        const serviceMap = readJsonFile<ServiceMapArtifact>(mapPath)
        if (serviceMap?.nodes?.length > 0) {
          selectedMap = serviceMap
        }
      } catch {
        selectedMap = fallbackMap
      }
    }

    const review = reviewPlan(
      flags.map,
      flags.plan,
      scope,
      selectedMap,
    )

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outJsonPath = path.join(context.cwd, 'plans', 'reviews', `${stamp}-${flags.map}.json`)
    const outMdPath = path.join(context.cwd, 'plans', 'reviews', `${stamp}-${flags.map}.md`)

    writeJsonFile(outJsonPath, review)
    writeTextFile(outMdPath, renderPlanReviewMarkdown(review))

    recordRun(context.db, 'plan_review', review.accepted ? 'ok' : 'error', flags.map, {
      missingNfrs: review.missingNfrs,
      impactedRepos: review.impactedRepos,
      output: outMdPath,
    })

    context.db.close()

    this.log(`Plan review written to ${outMdPath}`)
    if (!review.accepted) {
      throw new Error(`Plan review failed required NFR checks: ${review.missingNfrs.join(', ')}`)
    }
  }
}
