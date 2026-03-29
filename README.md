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
  <a href="https://github.com/dana0550/system-desiigner/releases"><img src="https://img.shields.io/github/v/release/dana0550/system-desiigner" alt="GitHub release"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933" alt="Node 20+">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-0E8A92" alt="MIT"></a>
</p>

<p align="center">
  <a href="#install-from-npm">Install from npm</a> •
  <a href="#one-command-setup">One-Command Setup</a> •
  <a href="#architecture-pack-org--service-deep-dives">Architecture Pack</a> •
  <a href="#canonical-root-readme-generation">Canonical README</a> •
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
- publish cross-repo spec-system contract-change PRs,
- generate Codex-ready context packs.

v1 remains manual-triggered. SDX can open draft notice PRs when you run publish commands, but it does not autonomously mutate runtime infrastructure.

## Install from npm
Prerequisite: Node.js `20+`.

Choose one install mode:

```bash
# A) No install, run directly (recommended for first run)
npx --yes sdx-cli@latest --help

# B) Global install
npm install -g sdx-cli
sdx --help

# C) Project-pinned install (recommended for teams)
npm install --save-dev sdx-cli
npx sdx --help
```

Team recommendation:
- use `bootstrap quick` once per org workspace,
- then run `./scripts/sdx ...` so the workspace stays pinned to one CLI version.

## One-Command Setup
### Org Initialization
Run this to initialize SDX for a GitHub org:

```bash
npx --yes sdx-cli@latest bootstrap quick <org>
```

Default naming rule:
- org-only input uses `<org>-system-designer` as the design repo/workspace name.
- explicit `<org>/<design-repo>` remains fully supported as an override.

This requires `sdx-cli` to be available on npm.

Examples:

```bash
# default design repo name: <org>-system-designer
npx --yes sdx-cli@latest bootstrap quick dana0550

# explicit design repo name override
npx --yes sdx-cli@latest bootstrap quick dana0550/platform-architecture
```

If npm publishing is not enabled yet in your org, use source mode:

```bash
git clone https://github.com/dana0550/system-desiigner.git
cd system-desiigner
npm ci && npm run build
node ./bin/run.js bootstrap quick <org>
```

This creates a dedicated workspace and a pinned wrapper script:
- `.sdx/config.json`
- `.sdx/install.json`
- `scripts/sdx`

Then run:

```bash
cd ./<org>-system-designer
./scripts/sdx status
```

### Quick bootstrap flags
```bash
npx --yes sdx-cli@latest bootstrap quick dana0550 \
  --seed \
  --createRemote
```

- `--seed`: auto-runs repo sync + default map seed (`all-services`) when `GITHUB_TOKEN` is present.
- `--createRemote` (alias: `--create-remote`): creates the design repo remotely (dedicated mode).
- `--inPlace` (alias: `--in-place`): initialize current directory instead of `./<design-repo>`.
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
./scripts/sdx architecture generate --map platform-core
./scripts/sdx docs readme --map platform-core
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

### Architecture Pack (Org + Service Deep Dives)
Generate an executive-ready architecture pack from your initialized consumer workspace:

```bash
# full pack (org-level + per-service docs/diagrams)
./scripts/sdx architecture generate --map platform-core

# org-level only
./scripts/sdx architecture generate --map platform-core --depth org

# targeted service rebuild
./scripts/sdx architecture generate --map platform-core --service payments-api

# explicit validation pass (override integrity + completeness checks)
./scripts/sdx architecture validate --map platform-core
```

Override source of truth:
- `maps/<map-id>/architecture-overrides.json`

Use overrides to:
- declare hidden or external dependencies,
- assert missing relationships,
- suppress incorrect inferred edges,
- attach service owner/criticality/business context metadata.

### Canonical Root README Generation
Generate a complete root `README.md` as the canonical onboarding and architecture overview for your org workspace.

```bash
# generate/update root README.md
./scripts/sdx docs readme --map platform-core

# write to a different output file
./scripts/sdx docs readme --map platform-core --output ARCHITECTURE.md

# check mode for CI (non-zero on stale sources, missing sources, or README drift)
./scripts/sdx docs readme --map platform-core --check

# dry-run preview with unified diff and freshness summary
./scripts/sdx docs readme --map platform-core --dry-run

# selective sections
./scripts/sdx docs readme --map platform-core \
  --include what_is_this_system,architecture_glance,service_catalog \
  --exclude glossary
```

Supported section IDs (baseline order):
- `what_is_this_system`
- `architecture_glance`
- `service_catalog`
- `critical_flows`
- `event_async_topology`
- `contracts_index`
- `repository_index`
- `environments_deployment`
- `data_stores_boundaries`
- `security_compliance`
- `local_dev_contribution`
- `runbooks_escalation`
- `adr_index`
- `glossary`
- `changelog_metadata`

README config file support (first existing file wins):
- `.sdx/readme.config.json`
- `.sdx/readme.config.yaml`
- `.sdx/readme.config.yml`

Config capabilities:
- section toggles (`sections.include`, `sections.exclude`, `sections.enabled`)
- repo include/exclude filters (`repos.include`, `repos.exclude`)
- domain grouping (`domainGroups`)
- owner/team overrides (`ownerTeamOverrides`)
- diagram behavior (`diagram.autoGenerateMissing`, `diagram.includeC4Links`)
- custom intro text (`customIntro`)
- stale threshold override in hours (`staleThresholdHours`, default `72`)

Manual content preservation:
- generated wrappers: `<!-- SDX:SECTION:<id>:START --> ... <!-- SDX:SECTION:<id>:END -->`
- preserved manual blocks: `<!-- SDX:SECTION:<id>:MANUAL:START --> ... <!-- SDX:SECTION:<id>:MANUAL:END -->`

CI automation example:
- copy [`docs/examples/readme-refresh.yml`](./docs/examples/readme-refresh.yml) into your consumer workspace repo under `.github/workflows/`.
- set repo/org variables:
  - `SDX_ORG` (required)
  - `SDX_MAP` (optional, defaults to `all-services` in the workflow)
- the workflow runs `repo sync`, `map build`, `contracts extract`, `docs generate`, and `docs readme`, then opens a PR.

## Cross-Repo Tech-Lead PRs (Spec-System Native)
Use this flow when SDX should create real `CC-*` contract-change PRs in downstream repos that have spec-system initialized.

```bash
# 1) Publish contract-change assignments (draft PRs by default)
./scripts/sdx publish notices --map platform-core --source-repo spec-system

# optionally publish one CC only
./scripts/sdx publish notices --map platform-core --source-repo spec-system --contract-change-id CC-101

# service onboarding mode: build source CC (`change_type: service_added`) from plan, then publish downstream PRs
./scripts/sdx publish notices --map platform-core --source-repo spec-system \
  --notice-type service \
  --plan ./plans/new-service-notice.md

# make PRs ready-for-review instead of drafts
./scripts/sdx publish notices --map platform-core --source-repo spec-system --ready

# dry run preview
./scripts/sdx publish notices --map platform-core --source-repo spec-system --dry-run

# 2) Refresh lifecycle state from existing PR URLs
./scripts/sdx publish sync --map platform-core --source-repo spec-system
```

Notes:
- SDX creates/updates target repo spec-system artifacts:
  - `docs/CONTRACT_CHANGES.md`
  - `docs/contracts/CC-###-<slug>.md`
- If a target repo is missing valid spec-system docs, publish fails fast with an explicit error.
- Source writeback still uses source sync PRs (no direct default-branch writes).
- Tokens need `contents:write` and `pull_requests:write` on source + target repos.

### Service Plan Requirements (`--notice-type service --plan <file>`)
The plan file must include these sections:

- `## Service Identity` with bullets for `service_id` and/or `name`
- `## Summary`
- `## Contract Surface`
- `## Compatibility and Migration Guidance`
- `## Target Repositories` with table columns: `repo | owner | context`

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
5. `./scripts/sdx architecture generate --map <map-id>`
6. `./scripts/sdx docs readme --map <map-id>`
7. `./scripts/sdx codex run <task-type> --map <map-id> --input <file>`

Where outputs land:
- `maps/<map-id>/service-map.json|md|mmd`
- `maps/<map-id>/contracts.json|md`
- `maps/<map-id>/architecture/model.json|validation.json`
- `maps/<map-id>/architecture-overrides.json`
- `docs/architecture/<map-id>/index.md`
- `docs/architecture/<map-id>/services/*.md`
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

sdx architecture generate|validate
sdx contracts extract
sdx docs generate|readme
sdx plan review
sdx service propose
sdx handoff draft
sdx publish notices|sync|wiki
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
  - versions packages from pending changesets,
  - commits and pushes the release version/changelog to `main`,
  - publishes to npm,
  - creates a GitHub Release tag (`vX.Y.Z`).
- Manual recovery mode:
  - run the `release` workflow via `workflow_dispatch` with `publish_existing=true` to publish the current `package.json` version when prior npm publish failed.
- Publish prerequisites:
  - configure npm auth for CI (`NPM_TOKEN` repo secret),
  - allow workflow pushes to `main` under your branch protection policy.
  - use an npm automation token with package `Read and write` and 2FA bypass enabled for CI publish.

Set npm token secret (maintainers):

```bash
gh secret set NPM_TOKEN --repo dana0550/system-desiigner
gh secret list --repo dana0550/system-desiigner | rg NPM_TOKEN
```

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
