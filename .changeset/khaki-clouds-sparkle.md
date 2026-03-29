---
"sdx-cli": minor
---

Add cross-repo tech-lead PR publishing with spec-system-native contract-change artifacts.

- Add `sdx publish notices --notice-type <contract|service>` with draft-by-default PRs, dry-run mode, and idempotent branch/PR upsert.
- Add `sdx publish sync` to refresh downstream PR lifecycle state (`opened|merged|blocked`) and update source contract-change status transitions.
- Publish real spec-system artifacts in target repos (`docs/CONTRACT_CHANGES.md` + `docs/contracts/CC-*.md`) instead of notice-only docs.
- Add fail-fast gating when target repos are missing valid spec-system contract index docs.
- Add service onboarding mode that builds/updates a source CC from `--plan <file>` before publishing downstream target PRs.
- Enforce map-scope repo resolution for source and target repos with explicit out-of-scope/missing errors.
- Persist publish trace artifacts under `publish/notices` and `publish/sync` and add run-log events.
- Add tests for parser round-trip, service plan parsing, fail-fast behavior, target artifact creation, idempotency, and sync lifecycle updates.
