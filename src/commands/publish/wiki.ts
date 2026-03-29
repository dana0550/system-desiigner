import fs from 'node:fs'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {ensureDir, writeTextFile} from '../../lib/fs'
import {loadProject, recordRun} from '../../lib/project'

function copyRecursive(source: string, target: string): void {
  const stat = fs.statSync(source)
  if (stat.isDirectory()) {
    ensureDir(target)
    const entries = fs.readdirSync(source, {withFileTypes: true})
    for (const entry of entries) {
      copyRecursive(path.join(source, entry.name), path.join(target, entry.name))
    }
    return
  }

  const body = fs.readFileSync(source, 'utf8')
  writeTextFile(target, body)
}

export default class PublishWikiCommand extends Command {
  static override description = 'Export docs-first artifacts to a wiki-friendly directory'

  static override flags = {
    map: Flags.string({required: true, description: 'Map identifier'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(PublishWikiCommand)
    const context = loadProject(process.cwd())

    const sourceFiles = [
      path.join(context.cwd, 'maps', flags.map, 'service-map.md'),
      path.join(context.cwd, 'maps', flags.map, 'contracts.md'),
      path.join(context.cwd, 'docs', 'architecture', `${flags.map}.md`),
    ]
    const sourceDirs = [
      path.join(context.cwd, 'docs', 'architecture', flags.map),
    ]

    const wikiDir = path.join(context.cwd, 'wiki-export', flags.map)
    ensureDir(wikiDir)

    for (const source of sourceFiles) {
      if (!fs.existsSync(source)) {
        continue
      }

      const target = path.join(wikiDir, path.basename(source))
      copyRecursive(source, target)
    }

    for (const source of sourceDirs) {
      if (!fs.existsSync(source)) {
        continue
      }

      const target = path.join(wikiDir, path.basename(source))
      copyRecursive(source, target)
    }

    recordRun(context.db, 'publish_wiki', 'ok', flags.map, {wikiDir})
    context.db.close()

    this.log(`Wiki export generated at ${wikiDir}`)
  }
}
