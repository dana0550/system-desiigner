import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo'])

export function listFilesRecursive(rootDir: string): string[] {
  const files: string[] = []

  function walk(current: string): void {
    const entries = fs.readdirSync(current, {withFileTypes: true})
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE.has(entry.name)) {
          continue
        }
        walk(path.join(current, entry.name))
        continue
      }

      files.push(path.join(current, entry.name))
    }
  }

  if (!fs.existsSync(rootDir)) {
    return files
  }

  walk(rootDir)
  return files
}

export function filterByPatterns(paths: string[], patterns: RegExp[]): string[] {
  return paths.filter((candidate) => patterns.some((pattern) => pattern.test(candidate)))
}
