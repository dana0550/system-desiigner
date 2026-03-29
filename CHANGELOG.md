# sdx-cli

## 0.2.1

### Patch Changes

- 4f59fd1: Clarify org bootstrap defaults and adopt org-derived design repo naming for quick setup.

  - `bootstrap quick <org>` now defaults to `<org>-system-designer` for dedicated workspace/repo naming.
  - Explicit `<org>/<design-repo>` inputs remain supported as an override.
  - Update bootstrap quick help/examples and startup output to show resolved design repo + workspace.
  - Refresh README org initialization guidance and command examples to match CLI behavior.
  - Add tests for org-only target parsing and default dedicated path resolution.

## 0.2.0

### Minor Changes

- eb36c3f: Add cross-repo tech-lead PR publishing with spec-system-native contract-change artifacts.

  - Add `sdx publish notices --notice-type <contract|service>` with draft-by-default PRs, dry-run mode, and idempotent branch/PR upsert.
  - Add `sdx publish sync` to refresh downstream PR lifecycle state (`opened|merged|blocked`) and update source contract-change status transitions.
  - Publish real spec-system artifacts in target repos (`docs/CONTRACT_CHANGES.md` + `docs/contracts/CC-*.md`) instead of notice-only docs.
  - Add fail-fast gating when target repos are missing valid spec-system contract index docs.
  - Add service onboarding mode that builds/updates a source CC from `--plan <file>` before publishing downstream target PRs.
  - Enforce map-scope repo resolution for source and target repos with explicit out-of-scope/missing errors.
  - Persist publish trace artifacts under `publish/notices` and `publish/sync` and add run-log events.
  - Add tests for parser round-trip, service plan parsing, fail-fast behavior, target artifact creation, idempotency, and sync lifecycle updates.

### Patch Changes

- 6615fe2: Align service notice publishing with spec-system service onboarding guidance.

  - In `sdx publish notices --notice-type service`, generate source and target contract-change rows/docs with `change_type: service_added`.
  - Add regression assertions to verify `service_added` appears in source sync and target artifacts.
  - Clarify README service-mode publish flow to explicitly call out `change_type: service_added`.

- 0fdd053: Polish public documentation and release operations for v1:

  - Add a simpler bootstrap path: `sdx bootstrap quick <org>` (or `<org>/<design-repo>`).
  - Rewrite README for public consumption with one-command onboarding, clearer daily flows, and Codex-oriented usage guidance.
  - Add a new hero header image at `assets/readme/hero.svg`.
  - Add MIT `LICENSE` file.
  - Adopt Changesets-based release automation on merges to `main`.
  - Add release scripts (`changeset`, `version-packages`, `release`) and Changesets configuration.
