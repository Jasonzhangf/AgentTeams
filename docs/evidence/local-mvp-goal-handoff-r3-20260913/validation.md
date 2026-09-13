# Validation receipt: local-mvp-goal-handoff-r3-20260913

- Root main and remote main were observed at `7e82b8a749409a19316ef5f389881848f9436b4b` before
  this worktree was created.
- The goal prompt names one canonical graph and requires startup re-reading of Git and worktree state;
  it does not promote runtime, CLI, provider, Console or live replay evidence.
- Runtime `3742b9a` remains the first delivery unit. Its r2 worktree is dirty and has no candidate
  commit; old candidates are explicitly non-reusable until rebased or rebuilt and revalidated.
- The dependency order remains `runtime → L1-CLI → W1 → B1 → U1 → I1/L5`, with C1 parallel only
  after a clean rebase and only inside its config/OpenCode paths.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm verify`: passed on the exact candidate worktree (77 files / 458 tests, typecheck, AppSDK
  guide compile, AppSDK compile, smoke and AppSDK verify `stage=contract_bound`); the normalized
  command/exit summary is in `pnpm-verify-summary.txt`.
- No runtime or product source was changed by this unit; the gate is documentation/governance
  baseline evidence only.
- Fingerprint receipts: `base.txt`, `tree.sha` (the staged candidate tree before this self-referential
  receipt file), `changed-paths.txt`, `pnpm-lock.sha`,
  `tool-versions.txt`, `pnpm-verify-summary.txt`, and `pnpm-verify.exit`.
- `artifact-scope.txt` records why product artifact hashes and public-entrypoint replay are not
  applicable to this documentation-only unit. `map-contract.txt` records the affected map/contract
  scope and unchanged product source boundary.
