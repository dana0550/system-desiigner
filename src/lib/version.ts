import fs from 'node:fs'
import path from 'node:path'

export function getCliPackageVersion(): string {
  const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json')
  const raw = fs.readFileSync(packageJsonPath, 'utf8')
  const data = JSON.parse(raw) as {version?: string}
  if (!data.version || typeof data.version !== 'string') {
    throw new Error(`Unable to resolve CLI version from ${packageJsonPath}`)
  }

  return data.version
}
