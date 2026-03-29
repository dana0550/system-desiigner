import fs from 'node:fs'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {isManagedArtifactPath, isManagedArtifactPayload} from '../../lib/artifactMigration'
import {SCHEMA_VERSION} from '../../lib/constants'
import {loadProject, recordRun} from '../../lib/project'

export default class MigrateArtifactsCommand extends Command {
  static override description = 'Migrate artifact files to the current schema version'

  static override flags = {
    from: Flags.string({required: false, description: 'Optional source version hint'}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(MigrateArtifactsCommand)
    const context = loadProject(process.cwd())

    const targets: string[] = []
    const roots = [path.join(context.cwd, 'maps'), path.join(context.cwd, 'plans'), path.join(context.cwd, 'handoffs'), path.join(context.cwd, 'codex')]

    for (const root of roots) {
      if (!fs.existsSync(root)) {
        continue
      }

      const stack = [root]
      while (stack.length > 0) {
        const current = stack.pop() as string
        for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
          const nextPath = path.join(current, entry.name)
          if (entry.isDirectory()) {
            stack.push(nextPath)
            continue
          }

          if (entry.name.endsWith('.json') && isManagedArtifactPath(context.cwd, nextPath)) {
            targets.push(nextPath)
          }
        }
      }
    }

    let migrated = 0
    for (const filePath of targets) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
        if (!isManagedArtifactPayload(data)) {
          continue
        }

        if (data.schemaVersion === SCHEMA_VERSION) {
          continue
        }

        data.schemaVersion = SCHEMA_VERSION
        data.migratedAt = new Date().toISOString()
        if (flags.from) {
          data.migratedFrom = flags.from
        }

        fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        migrated += 1
      } catch {
        continue
      }
    }

    recordRun(context.db, 'migrate_artifacts', 'ok', undefined, {migrated, scanned: targets.length})
    context.db.close()

    this.log(`Migrated ${migrated} artifact files to schema ${SCHEMA_VERSION}.`)
  }
}
