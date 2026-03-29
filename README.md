<p align="center">
  <img src="./assets/readme/banner_v2.png" alt="SDX hero" width="100%" />
</p>

<h1 align="center">SDX CLI</h1>

<p align="center">
  System design intelligence across many repositories, with one docs-first workspace.
</p>

<p align="center">
  <a href="https://github.com/dana0550/system-desiigner/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dana0550/system-desiigner/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/dana0550/system-desiigner/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/dana0550/system-desiigner/release.yml?branch=main&label=Release" alt="Release"></a>
  <a href="https://www.npmjs.com/package/sdx-cli"><img src="https://img.shields.io/npm/v/sdx-cli" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/sdx-cli"><img src="https://img.shields.io/npm/dm/sdx-cli" alt="npm downloads"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node 20+">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0E8A92" alt="MIT"></a>
</p>

<p align="center">
  <a href="#one-command-setup">One-Command Setup</a> •
  <a href="#daily-workflow">Daily Workflow</a> •
  <a href="#for-codex-agents">For Codex Agents</a> •
  <a href="#release-process">Release Process</a>
</p>

## What SDX is
SDX gives your team a single architecture workspace that sits above service repos.

You use it to:
- map services across repos,
- track contracts,
- review new service plans,
- draft cross-team integration handoffs,
- generate Codex-ready context packs.

It is advisory by design in v1. It does not auto-open PRs or mutate infra.

## One-Command Setup
If you only remember one command, use this:

```bash
npx --yes sdx-cli@latest bootstrap quick <org>
```

Examples:

```bash
# default design repo name: system-design
npx --yes sdx-cli@latest bootstrap quick dana0550

# explicit design repo name
npx --yes sdx-cli@latest bootstrap quick dana0550/system-design
```

This creates a dedicated workspace and a pinned wrapper script:
- `.sdx/config.json`
- `.sdx/install.json`
- `scripts/sdx`

Then run:

```bash
cd ./system-design
./scripts/sdx status
```

### Quick bootstrap flags
```bash
npx --yes sdx-cli@latest bootstrap quick dana0550/system-design \
  --seed \
  --create-remote
```

- `--seed`: auto-runs repo sync + default map seed (`all-services`) when `GITHUB_TOKEN` is present.
- `--create-remote`: creates the design repo remotely (dedicated mode).
- `--in-place`: initialize current directory instead of `./<design-repo>`.
- `--dir <path>`: override target directory.
- `--pin <version>`: pin wrapper to a specific CLI version.

## Daily Workflow
From your SDX workspace root:

```bash
./scripts/sdx repo sync --org <org>
./scripts/sdx repo add --name <repo-name> --path </abs/path/to/local/clone>

./scripts/sdx map create platform-core --org <org>
./scripts/sdx map include platform-core repo-a repo-b
./scripts/sdx map exclude platform-core legacy-repo
./scripts/sdx map build platform-core

./scripts/sdx contracts extract --map platform-core
./scripts/sdx docs generate --map platform-core
```

For planning and rollout:

```bash
./scripts/sdx plan review --map platform-core --plan ./plans/new-service.md
./scripts/sdx service propose --map platform-core --brief ./plans/new-service-brief.md
./scripts/sdx handoff draft --map platform-core --service payments-orchestrator
```

For Codex:

```bash
./scripts/sdx codex run implementation-plan --map platform-core --input ./plans/new-service.md
```

## Prompt-Driven Scope Edits
Preview first, apply second:

```bash
./scripts/sdx prompt "exclude legacy-repo from map" --map platform-core
./scripts/sdx prompt "exclude legacy-repo from map" --map platform-core --apply
```

## For Codex Agents
Use this minimal runbook when an agent needs architecture context quickly:

1. `./scripts/sdx status`
2. `./scripts/sdx map status <map-id>`
3. `./scripts/sdx map build <map-id>`
4. `./scripts/sdx contracts extract --map <map-id>`
5. `./scripts/sdx codex run <task-type> --map <map-id> --input <file>`

Where outputs land:
- `maps/<map-id>/service-map.json|md|mmd`
- `maps/<map-id>/contracts.json|md`
- `codex/context-packs/*.json`
- `codex/runs/*.md|json`

## Command Surface
```bash
sdx init
sdx bootstrap org
sdx bootstrap consumer
sdx bootstrap quick

sdx repo sync
sdx repo add

sdx map create|include|exclude|remove-override|status|build
sdx prompt

sdx contracts extract
sdx docs generate
sdx plan review
sdx service propose
sdx handoff draft
sdx publish wiki
sdx codex run

sdx status
sdx version
sdx migrate artifacts
```

Full help:

```bash
sdx --help
sdx <topic> --help
sdx <topic> <command> --help
```

## Release Process
This repo uses Changesets and releases from `main`.

- Add a changeset for user-facing changes:
  - `npm run changeset`
- Merges to `main` trigger the release workflow.
- Workflow behavior:
  - opens/updates a Release PR when there are pending changesets,
  - publishes to npm when release commits are present.

Maintainer commands:

```bash
npm run version-packages
npm run release
```

## Environment
```bash
export GITHUB_TOKEN=<token>
export CODEX_CMD=<optional-codex-binary-name>
```

## Local Development
```bash
npm ci
npm run typecheck
npm test
npm run build
node ./bin/run.js --help
```

## License
MIT
