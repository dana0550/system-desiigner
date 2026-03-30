import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {SCHEMA_VERSION} from './constants'
import {readJsonFile, safeReadText, writeJsonFile, writeTextFile} from './fs'
import {getCodexDir, getMapDir} from './paths'
import {CodexContextPack, ServiceMapArtifact} from './types'

interface CodexRunInput {
  taskType: string
  mapId: string
  codexCommand: string
  inputFile?: string
  constraints?: string[]
  cwd?: string
}

interface CodexRunResult {
  contextPackPath: string
  promptPath: string
  runMarkdownPath: string
  runJsonPath: string
  exitCode: number
  invocationMode: 'stdin' | 'argv'
}

export interface CodexPromptRunInput {
  taskType: string
  codexCommand: string
  prompt: string
  cwd?: string
  metadata?: Record<string, unknown>
  artifactStem?: string
}

export interface CodexPromptRunResult {
  promptPath: string
  runMarkdownPath: string
  runJsonPath: string
  exitCode: number
  invocationMode: 'stdin' | 'argv'
  stdout: string
  stderr: string
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function loadServiceMap(mapId: string, cwd = process.cwd()): ServiceMapArtifact {
  const mapPath = path.join(getMapDir(mapId, cwd), 'service-map.json')
  return readJsonFile<ServiceMapArtifact>(mapPath)
}

function createPrompt(taskType: string, contextPack: CodexContextPack, inputBody?: string): string {
  const lines = [
    `Task Type: ${taskType}`,
    '',
    'Use the attached architecture context and produce actionable engineering output.',
    '',
    'Context (JSON):',
    JSON.stringify(contextPack, null, 2),
    '',
  ]

  if (inputBody) {
    lines.push('Additional Input:')
    lines.push(inputBody)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

export function runCodexPrompt(input: CodexPromptRunInput): CodexPromptRunResult {
  const cwd = input.cwd ?? process.cwd()
  const codexDir = getCodexDir(cwd)
  const stem = input.artifactStem ?? `${timestamp()}-${input.taskType}`
  const promptPath = path.join(codexDir, 'runs', `${stem}.prompt.txt`)
  const runMarkdownPath = path.join(codexDir, 'runs', `${stem}.md`)
  const runJsonPath = path.join(codexDir, 'runs', `${stem}.json`)

  writeTextFile(promptPath, input.prompt)

  let invocationMode: 'stdin' | 'argv' = 'stdin'
  let result = spawnSync(input.codexCommand, ['exec'], {
    input: input.prompt,
    encoding: 'utf8',
    cwd,
    timeout: 1000 * 60 * 10,
  })

  const firstCombined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase()
  const needsArgFallback =
    result.status !== 0 &&
    /usage|missing|required/.test(firstCombined) &&
    !/error/.test(firstCombined)

  if (needsArgFallback) {
    invocationMode = 'argv'
    result = spawnSync(input.codexCommand, ['exec', input.prompt], {
      encoding: 'utf8',
      cwd,
      timeout: 1000 * 60 * 10,
    })
  }

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const exitCode = typeof result.status === 'number' ? result.status : 1

  writeJsonFile(runJsonPath, {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    taskType: input.taskType,
    command: input.codexCommand,
    args: invocationMode === 'stdin' ? ['exec', '<stdin:prompt>'] : ['exec', '<prompt-arg>'],
    invocationMode,
    exitCode,
    stdout,
    stderr,
    promptPath,
    metadata: input.metadata ?? {},
  })

  const markdown = [
    `# Codex Run: ${input.taskType}`,
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Command: ${input.codexCommand}`,
    `- Exit Code: ${exitCode}`,
    `- Invocation Mode: ${invocationMode}`,
    `- Prompt File: ${promptPath}`,
    '',
    '## Stdout',
    '',
    '```txt',
    stdout,
    '```',
    '',
    '## Stderr',
    '',
    '```txt',
    stderr,
    '```',
    '',
  ].join('\n')

  writeTextFile(runMarkdownPath, markdown)

  if (result.error) {
    throw new Error(`Codex invocation failed: ${result.error.message}`)
  }

  return {
    promptPath,
    runMarkdownPath,
    runJsonPath,
    exitCode,
    invocationMode,
    stdout,
    stderr,
  }
}

export function runCodexTask(input: CodexRunInput): CodexRunResult {
  const cwd = input.cwd ?? process.cwd()
  const serviceMap = loadServiceMap(input.mapId, cwd)
  const contextPack: CodexContextPack = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mapId: input.mapId,
    taskType: input.taskType,
    constraints: input.constraints ?? [
      'Respect existing service ownership boundaries.',
      'Keep contract changes backward compatible by default.',
      'Return explicit assumptions and risks.',
    ],
    affectedRepos: [...serviceMap.repos],
    graphSlice: {
      nodes: serviceMap.nodes,
      edges: serviceMap.edges,
    },
    inputFile: input.inputFile,
  }

  const codexDir = getCodexDir(cwd)
  const stamp = timestamp()
  const contextPackPath = path.join(codexDir, 'context-packs', `${stamp}-${input.taskType}.json`)
  const artifactStem = `${stamp}-${input.taskType}`

  writeJsonFile(contextPackPath, contextPack)

  const inputBody = input.inputFile ? safeReadText(path.resolve(input.inputFile)) : undefined
  const prompt = createPrompt(input.taskType, contextPack, inputBody)
  const promptRun = runCodexPrompt({
    taskType: input.taskType,
    codexCommand: input.codexCommand,
    prompt,
    cwd,
    artifactStem,
    metadata: {
      mapId: input.mapId,
      contextPackPath,
    },
  })

  return {
    contextPackPath,
    promptPath: promptRun.promptPath,
    runMarkdownPath: promptRun.runMarkdownPath,
    runJsonPath: promptRun.runJsonPath,
    exitCode: promptRun.exitCode,
    invocationMode: promptRun.invocationMode,
  }
}
