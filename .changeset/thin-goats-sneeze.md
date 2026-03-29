---
"sdx-cli": patch
---

Clarify org bootstrap defaults and adopt org-derived design repo naming for quick setup.

- `bootstrap quick <org>` now defaults to `<org>-system-designer` for dedicated workspace/repo naming.
- Explicit `<org>/<design-repo>` inputs remain supported as an override.
- Update bootstrap quick help/examples and startup output to show resolved design repo + workspace.
- Refresh README org initialization guidance and command examples to match CLI behavior.
- Add tests for org-only target parsing and default dedicated path resolution.
