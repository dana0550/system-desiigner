---
"sdx-cli": patch
---

Polish public documentation and release operations for v1:

- Add a simpler bootstrap path: `sdx bootstrap quick <org>` (or `<org>/<design-repo>`).
- Rewrite README for public consumption with one-command onboarding, clearer daily flows, and Codex-oriented usage guidance.
- Add a new hero header image at `assets/readme/hero.svg`.
- Add MIT `LICENSE` file.
- Adopt Changesets-based release automation on merges to `main`.
- Add release scripts (`changeset`, `version-packages`, `release`) and Changesets configuration.
