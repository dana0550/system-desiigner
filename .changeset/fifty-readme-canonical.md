---
"sdx-cli": patch
---

Add `sdx docs readme` as a first-class canonical README generator for org architecture workspaces.

Highlights:
- New command surface: `--output`, `--check`, `--dry-run`, `--include`, `--exclude`
- Deterministic root README rendering with per-section managed blocks and manual block preservation
- Traceability and freshness checks against SDX artifacts with configurable stale thresholds
- Diagram linking/generation for system context, service dependency, and core request flow sequence diagrams
- `.sdx/readme.config.json|yaml|yml` support for section toggles, repo filters, owner overrides, and diagram options
- Added CI workflow example: `docs/examples/readme-refresh.yml`
