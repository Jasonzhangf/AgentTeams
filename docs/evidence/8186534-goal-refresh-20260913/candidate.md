# Candidate receipt

- issue: `8186534`
- unit: Local MVP delivery handoff and goal prompt refresh
- base: `3668b324af228218a99f39cc979ee34947dfc387`
- candidate commit: pending; exact review is against the staged/uncommitted candidate tree; after
  review PASS, record the actual commit hash in the integration receipt.
- owner: Desktop primary scheduler/resource manager
- allowed paths: `docs/goals/**`, `docs/evidence/8186534-goal-refresh-20260913/**`
- forbidden paths: runtime, network, agent, config, UI, package and lockfile
- changed goal surfaces:
  - `docs/goals/teams-local-mvp-goal-prompt.md`
  - `docs/goals/teams-local-mvp-execution-plan.md`
  - `docs/goals/teams-user-mvp-delivery.md`
- product source changed: no
- exact source diff fingerprint: `db21a2b1b5f870252b7fda0920ac4106afe320e60972dfdf4494b3bd81570c13`
- purpose: rebind the user MVP target, dependency order, current main baseline, active runtime unit,
  scheduler ownership and resource rules to the current post-governance mainline.
