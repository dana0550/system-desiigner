---
"sdx-cli": minor
---

Add architecture pack generation for initialized consumer workspaces.

- New commands: `sdx architecture generate` and `sdx architecture validate`.
- New canonical architecture model artifact with provenance/confidence metadata.
- New per-map overrides file: `maps/<map-id>/architecture-overrides.json` for asserted/suppressed edges and service metadata.
- Generate org-level system diagrams and per-service deep-dive architecture docs/contract diagrams.
- Extend wiki export to include generated architecture pack docs.
