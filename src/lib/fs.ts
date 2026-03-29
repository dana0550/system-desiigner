import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, {recursive: true})
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeTextFile(filePath: string, value: string): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, value, 'utf8')
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath)
}

export function safeReadText(filePath: string): string {
  if (!fileExists(filePath)) {
    return ''
  }

  return fs.readFileSync(filePath, 'utf8')
}
