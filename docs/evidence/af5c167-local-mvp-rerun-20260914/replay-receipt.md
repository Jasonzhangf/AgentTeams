# AgentTeams Local MVP current-SHA replay receipt

- Unit: `af5c167` (existing long-running goal; reused, no new issue)
- Base ref: `origin/main`
- Base commit / worktree HEAD before evidence files: `7f1b13334ee57a3caee8e7cf1e4fac17ce6d5850`
- Base tree: `0a2f25338fdeb7fdb78c46c68a41d9cbd0d2ae93`
- Candidate commit: pending review (candidate is the staged evidence-only delta)
- Candidate tree: exact staged tree hash is recorded in `review-receipt.md`; the lifecycle receipt is
  deliberately kept outside that pre-review tree to avoid self-referential hashes
- Worktree: `playground/af5c167-local-mvp-rerun-20260914`
- Scope: local disposable-HOME user path and Console-offline Agent Work. No public Relay, NAT, mobile, or production claim.

The candidate changes only `docs/evidence/af5c167-local-mvp-rerun-20260914/**`; no runtime, network,
configuration, UI, dependency, or generated source is changed. The candidate is based directly on
`origin/main` and is reviewed as an evidence-only delta before its commit is created.

## Commands and observations

The clean worktree installed the locked dependencies and built the runtime entrypoint:

```text
pnpm install --frozen-lockfile       PASS
pnpm build:runtime                   PASS
```

The current candidate then executed the real CLI entrypoint in a disposable `HOME`:

```text
agentteams init                    PASS
agentteams start                   PASS; state=running generation=1
agentteams status                  PASS; provider and receiver online
agentteams work                    PASS; receiver/configured-search succeeded
agentteams stop --generation 1     PASS; state=stopped
agentteams start                   PASS; state=running generation=2
agentteams status                  PASS; both endpoints online
agentteams work                    PASS; receiver/configured-search succeeded
agentteams stop --generation 1     PASS rejection; stale local supervisor generation expected=1 current=2
agentteams stop --generation 2     PASS; state=stopped
```

The provider projection exposed `browser@1` and `file-search@1` with nested resources; the receiver
projection exposed no capabilities. The replay did not start a Console process. `internal.toml` after
the final stop contained `launcher.generation = 2`, `state = "stopped"`, both daemon records with
`state = "stopped"`, matching generation `2`, and the successful configured Work record.

Current-SHA mapped checks (raw output and exit status are retained beside this receipt):

```text
pnpm exec vitest run --no-file-parallelism --configLoader runner \
  runtime/console-hub.spec.ts runtime/console-runtime.spec.ts \
  runtime/console-work-projection.spec.ts runtime/console-config.spec.ts \
  console-host/tests/http-api.spec.ts ui/teams-console/tests/api.spec.ts \
  ui/teams-console/tests/model.spec.ts
=> exit 0; 7 files / 32 tests passed (`mapped-tests.log`)

pnpm typecheck                     exit 0 (`typecheck.log`)
pnpm build                         exit 0 (`build.log`)
appsdk compile                     exit 0; compiled artifact output retained in `appsdk-compile.log`
pnpm smoke                         exit 0; packaged Console and runtime smoke (`smoke.log`)
appsdk verify                      exit 0; `command_ok=true`, `development_ready=true`, `delivery_assessed=false`, `delivery_verified=false` because delivery was not evaluated (`appsdk-verify.log`)
git diff --check                   exit 0 (`diff-check.log`)

The exact CLI replay transcript, including the stale-generation rejection and final `internal.toml`,
is `replay.log`; the final state snapshot is also retained as `internal-final.toml`.
The command exit codes are recorded independently in `exit-status.log`; the expected stale-generation
rejection is recorded as exit `1` while the final stop is exit `0`.

The AppSDK artifact hash is intentionally observational here: AppSDK includes `docs/**` in its source
fingerprint, so adding this evidence receipt changes that hash. Artifact identity is therefore kept in
the retained compile log and is not used as the identity of this evidence-only candidate.
```

This receipt proves the local CLI/daemon path and current-SHA Console projection checks. It does not
prove public/NAT/mobile deployment or the full Console HTTP readback sequence required by the older
V1 issue history.
