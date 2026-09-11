# 3c437d7 cleanup receipt

- Candidate `5a4a3f5f501c6cf184cebeb935eafce73efeaa51` and integration receipt `21e13a2` are on remote `main` at the time of cleanup.
- Stopped processes/listeners owned by this docs-only unit: none were started.
- Removed clean worktrees: `playground/n1-relay-deploy-20260911` and `playground/integration-3c437d7-20260911`.
- Removed local branches: `codex/n1-relay-deploy-20260911` and `codex/integration-3c437d7-20260911`.
- Independent review and integration evidence remains under `docs/evidence/3c437d7-integration-20260911/`; the runbook remains at `server/deploy/relay-public-nat-runbook.md`.
- The issue remains open: this unit provides procedure/evidence boundaries only; public Relay, NAT, installation/restart, two-daemon Work and Console-offline live replay are not claimed.
