# Goal plan reconciliation receipt

- Delivery unit: `8aeb3fa` goal-plan refresh.
- Candidate base: `f38b6d90d8d4cc312a92da21e666196f8327b9b5`.
- Scope: reconcile the resumable scheduling pointer with the canonical Local MVP phase labels
  and the completed U0 runtime-source delivery.

## Authoritative current state

- U0 issue `159b78b` is closed. Its candidate, exact review, integration, push, solution, cleanup,
  and memory evidence is authoritative under
  `docs/evidence/159b78b-internal-config-20260913/`.
- The current remote mainline is `f38b6d90d8d4cc312a92da21e666196f8327b9b5`.
- The prior `docs/evidence/8aeb3fa-goal-plan-20260913/` receipts remain historical records of the
  earlier plan candidate. They are superseded for current scheduling state by this reconciliation
  receipt and the U0 receipt set; they are not rewritten.
- The current plan binds the new `cli/**` user facade to the architecture maps: `cli-facade` in
  `module-registry.json`, `cli_user_facade` in `function-map.json`, `cli-user-entry-v1` in
  `mainline-call-map.json`, `cli-user-command` in `resource-map.json`, and `teams-l1-cli` in
  `verification-map.json`. These bindings are planning contracts; the CLI implementation remains
  an unfinished L1 delivery unit.

## Label reconciliation

- `W1` is Agent Work/resource admission.
- `C1` is Config/OpenCode provider management.
- `L1-CLI` is the user launcher facade for `init/start/status/work/stop`.
- `B1` is the fixed CLI capability unit after the W1 interface is stable.
- `U1` is Console directory projection.
- `I1/L5` is the final integration and Console-offline/restart replay.
- The N1/N2 labels in the relay-first reference table are public Relay/NAT post-MVP work. Phase 1
  uses local L1/L2 launcher/bridge receipts and does not dispatch or claim public N1/N2 complete.

The execution plan now dispatches the first canonical unit whose dependency receipt is missing and
does not create a second U1 meaning. This receipt does not claim B1, W1, C1, U1, or I1/L5 complete.

## Verification

- `appsdk verify` passed with `stage=contract_bound`.
- `git diff --check` passed.
- `pnpm install --frozen-lockfile` completed in the disposable worktree.
- `pnpm verify` passed: regression (77 files/458 tests), typecheck, AppSDK guide compile, AppSDK
  compile, smoke, and AppSDK verify (`stage=contract_bound`).
- All five architecture maps passed `jq empty`; `git diff --check` passed. The dependency
  installation is worktree-local and is not part of the candidate diff.

## Candidate fingerprint

- Candidate state: staged but uncommitted planning candidate; no candidate commit exists. Source anchor is
  `HEAD=f38b6d90d8d4cc312a92da21e666196f8327b9b5`; `origin/main` was the same SHA at capture time.
- Worktree: `/Volumes/extension/code/AgentTeams/playground/goal-plan-refresh-20260913`;
  branch `codex/goal-plan-refresh-20260913`.
- The candidate diff SHA-256 (excluding the self-referential manifest file) is recorded in the
  `candidate-diff-sha256-excluding-manifest` line of `candidate-fingerprint.txt`.
- At candidate review time, the candidate included the five architecture maps, the two goal
  documents, this receipt, and the raw verification files present then. The raw command outputs
  are retained beside this receipt:
  `pnpm-verify.log`, `map-parse.log`, `diff-check.log`, `environment.log`, and
  `candidate-fingerprint.txt`. The `evidence-sha256` section of `candidate-fingerprint.txt` is a
  per-file manifest for every evidence file except the manifest itself; it is regenerated after the
  final candidate evidence set is fixed. The later `integration-receipt.md`, `push-receipt.md`, and
  `cleanup-receipt.md` are post-candidate lifecycle records and are intentionally outside that
  candidate fingerprint.
- Environment: Node `v22.22.2`, pnpm `10.31.0`, AppSDK CLI present, Darwin arm64. The AppSDK
  contract digest reported by the verify run is
  `sha256:86407ecbbad07f82e32046ac1d89d56fb3a74356b943ba0368e4b85a2bab5393`; the governance
  manifest hash is `sha256:33064eebb4b8ffb2f669866770deeba4f5a5a03d46adc6ff5e36754fc1137e64`.
- The latest verify run returned `verify_exit=0`. The generated artifact hash was
  `sha256:963dcbca9cdd8d99ddfee91f9bedc79c54f625991abea432d57c3938da3b6212`; this is governance
  validation evidence only and does not claim a released or deployed artifact.
