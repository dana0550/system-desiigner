---
"sdx-cli": patch
---

Align service notice publishing with spec-system service onboarding guidance.

- In `sdx publish notices --notice-type service`, generate source and target contract-change rows/docs with `change_type: service_added`.
- Add regression assertions to verify `service_added` appears in source sync and target artifacts.
- Clarify README service-mode publish flow to explicitly call out `change_type: service_added`.
