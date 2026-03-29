# Changesets

Use `npm run changeset` for user-facing changes.

Release automation runs on pushes to `main`:
- If pending changesets exist, it opens or updates a release PR.
- If a release commit lands on `main`, it publishes to npm and creates a GitHub release.
