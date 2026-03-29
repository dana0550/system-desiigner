---
"sdx-cli": patch
---

Harden CI/release workflows by applying least-privilege permissions and upgrading GitHub Actions to current major versions.

- Set explicit `contents: read` permissions in CI.
- Remove unused `id-token: write` from release workflow.
- Upgrade `actions/checkout` and `actions/setup-node` from `v4` to `v5`.
