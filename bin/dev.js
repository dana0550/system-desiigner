#!/usr/bin/env node

const {spawnSync} = require('node:child_process')
const path = require('node:path')

const tsxBin = path.join(__dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const result = spawnSync(tsxBin, ['src/index.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
