# Integration receipt: Phase 1 Local Network MVP closeout

- Issue: `2dcd928`
- Integration worktree: `playground/integration-2dcd928-phase1-closeout-20260913`
- Base: `origin/main@3354271d4ddc72c270f2d6304e2430558c0c6eaa`
- Integrated commit: `fc841ca58b8ba5809d1e90c522e114add6393b64`
- Integrated tree: `2091ff337ad31d4192e2d9a42402a4de3fc24b76`
- Scope: `docs/evidence/2dcd928-phase1-closeout-20260913/**`
- Source/runtime changes: none; the delivery records and binds previously
  integrated Local Network MVP evidence.

## Integrated commits

The unit was cherry-picked in this order:

1. `9bc1b48` — Phase 1 closeout audit
2. `c705411` — closeout audit review
3. `94df06b` — normalized verification evidence
4. `753b780` — normalized exact review receipt
5. `a3952a7` — corrected review history
6. `99a3437` — corrected exact review receipt
7. `74b59a4` — closeout gate fingerprint
8. `bfd1939` — focused replay command and output
9. `4805f6d` — corrected evidence snapshot binding

## Integration verification

- `integration-install.log` — `pnpm install --frozen-lockfile` passed; SHA-256
  `8d75e620c409bae3881f66eda38fe7ee91f910c02712701e021e71b1ff15dd15`.
- `integration-verify.log` — `pnpm verify` passed: 75 test files, 447 tests,
  typecheck, OpenCode/Console/UI builds, AppSDK guide compile, AppSDK compile,
  packaged smoke and `appsdk verify`; SHA-256
  `465922acfc84086792ee532608c077d6c07e71c335eea60c70c18eab74afa399`.
- `integration-diff-check.log` — `git diff --check origin/main..HEAD` passed;
  SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- AppSDK final state: `project_id=agentteams`, `stage=contract_bound`,
  `appsdk verify` exit 0 in `integration-verify.log`.

The integrated evidence retains the same Phase 1 boundary: local network
bridge, local daemon launcher, Agent Work/resource semantics, provider/OpenCode,
UI discovery and Console-offline behavior. Public Relay, NAT/STUN, mobile,
direct internet, complete UI, provider failover and long-running-goal closure
remain open follow-up work.
