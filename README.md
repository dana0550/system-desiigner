# sdx-cli

`sdx` is a docs-first, cross-repository system design intelligence CLI.

## Consumer Bootstrap (Recommended)

Initialize SDX in another org/team workspace with a pinned CLI wrapper:

```bash
npx --yes sdx-cli@<version> bootstrap consumer --org <github-org> --design-repo <system-design-repo>
```

By default this creates a dedicated target directory `./<design-repo>` with:

- `.sdx/config.json` (repo-local state)
- `.sdx/install.json` (pinned install manifest)
- `scripts/sdx` (wrapper pinned to `sdx-cli@<version>`)

Optional flags:

```bash
npx --yes sdx-cli@<version> bootstrap consumer \
  --org <github-org> \
  --design-repo <system-design-repo> \
  --mode dedicated \
  --target-dir ./system-design \
  --pin <version> \
  --seed-default-map \
  --create-remote
```

Upgrade path:

- Re-run bootstrap with a new pin: `--pin <new-version>`
- Wrapper updates are explicit and versioned via `.sdx/install.json`

## What It Does

- Syncs repositories from a GitHub org and registers local clones.
- Builds named service maps with deterministic include/exclude scope controls.
- Generates service-map artifacts (`.json`, `.md`, `.mmd`) and scope change logs.
- Extracts API/event contracts (OpenAPI, GraphQL, Proto, AsyncAPI).
- Produces architecture docs, plan reviews, service proposals, and handoff drafts.
- Invokes Codex CLI with generated architecture context packs and stores transcripts.

## Quick Start

```bash
npm ci
npm run build
node ./bin/run.js init
node ./bin/run.js bootstrap org --org <github-org> --repo <design-repo>
node ./bin/run.js repo sync --org <github-org>
node ./bin/run.js map create platform-core --org <github-org>
node ./bin/run.js map build platform-core
node ./bin/run.js contracts extract --map platform-core
node ./bin/run.js docs generate --map platform-core
```

## Scope Curation

```bash
node ./bin/run.js map include platform-core repo-a,repo-b
node ./bin/run.js map exclude platform-core legacy-repo
node ./bin/run.js map remove-override platform-core legacy-repo
node ./bin/run.js map status platform-core
```

Prompt-mode preview/apply:

```bash
node ./bin/run.js prompt "exclude legacy-repo from map" --map platform-core
node ./bin/run.js prompt "exclude legacy-repo from map" --map platform-core --apply
```

## Codex Integration

```bash
node ./bin/run.js codex run implementation-plan --map platform-core --input ./plans/new-service.md
```

This writes:

- `codex/context-packs/*.json`
- `codex/runs/*.md`
- `codex/runs/*.json`

## Testing

```bash
npm test
npm run typecheck
npm run build
```
