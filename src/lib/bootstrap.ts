import path from 'node:path'
import {ensureDir, writeTextFile} from './fs'

export function createBootstrapStructure(org: string, repoName: string, cwd = process.cwd()): void {
  const workflowDir = path.join(cwd, '.github', 'workflows')
  ensureDir(workflowDir)

  writeTextFile(
    path.join(workflowDir, 'sdx-ci.yml'),
    [
      'name: sdx-ci',
      '',
      'on:',
      '  push:',
      '    branches: [main]',
      '  pull_request:',
      '',
      'jobs:',
      '  build-test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          node-version: 20',
      '      - run: npm ci',
      '      - run: npm run typecheck',
      '      - run: npm run test',
      '      - run: npm run build',
      '',
    ].join('\n'),
  )

  writeTextFile(
    path.join(cwd, 'BOOTSTRAP.md'),
    [
      '# SDX Bootstrap',
      '',
      `- Organization: ${org}`,
      `- Design Repository: ${repoName}`,
      '',
      'This repository is configured as a docs-first system-design intelligence workspace.',
      '',
    ].join('\n'),
  )
}
