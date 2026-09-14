# Candidate Receipt: 3742b9a Runtime R6

## Audit of r5 input

- Read-only audit performed against `playground/3742b9a-runtime-r5-20260913`.
- r5 status was dirty with unstaged runtime diff and untracked r5 evidence; no staged diff.
- Only runtime contract changes were migrated into r6; r5 evidence files were not copied.
- Allowed r6 write paths only; no other worktree was modified.

## Root cause

The r5 configured-Work restart path had `START_TIMEOUT`/stale control risk because internal lifecycle state was not serialized with one ownership owner:

- `internal.toml` rewrites from `loadLocalConfig`, daemon state, launcher state, and configured-Work receipts could race and drop fields.
- Launcher generation/start token were not consistently carried into detached agent children as the only receipt source.
- A stale generation could either write over a newer receipt or the receiver could never see a current-generation receipt.

Minimal r6 fix:

- Add `[launcher]` and `[configuredWork]` to `internal.toml` and read/serialize them.
- Serialize all internal config read-modify-write updates with `withLocalInternalConfigLock`.
- Persist launcher ownership (`launcher-owner.json`) and PID/state/start-token/generation.
- Reserve the next generation before spawning the detached supervisor.
- Start/status/stop APIs only accept the persisted owner token.
- Agent `configuredWork` receipts are written only when the launcher generation/start token still match.
- A timed-out detached start invalidates the reservation and signals the owned supervisor; the supervisor refuses to publish `running` after cancellation.
- A failed supervisor preserves a persisted `failed` launcher state, and a lost launcher cleans up only child PIDs whose command and config path prove ownership before reporting `stopped`.

## Changed paths

```text
runtime/agent-process.ts
runtime/configured-work.spec.ts
runtime/local-config.spec.ts
runtime/local-config.ts
runtime/local-process.spec.ts
runtime/local-process.ts
runtime/local-supervisor.ts
runtime/local-two-agent.spec.ts
server/relay-process.ts
docs/evidence/3742b9a-runtime-r6-20260914/base.txt
docs/evidence/3742b9a-runtime-r6-20260914/candidate-receipt.md
docs/evidence/3742b9a-runtime-r6-20260914/validation-evidence.md
```

## Candidate fingerprint

```text
source diff sha256: b843d7f3a686122c9c0fb765cdc8808429ab40e89b2c9574ad5059873db9a7ae
The focused, socket-backed, typecheck/build, smoke, AppSDK, and `pnpm verify`
receipts in `validation-evidence.md` were rerun after the source diff reached
this fingerprint. Evidence documents are reviewed with this exact worktree;
the receipt itself is excluded from the source fingerprint to avoid a
self-referential hash.
```

No commit, push, merge, memory promotion, or issue close is claimed at this receipt stage.

Exact review history:
- `20260914T012803Z-review-98434-1tq81q`: FAIL, missing runtime live evidence.
- `20260914T013318Z-review-98434-9gxjaw`: FAIL, timeout cancellation and candidate verification findings.
- `20260914T014159Z-review-98434-chn1gx`: FAIL, pending source fingerprint only.
- `20260914T014534Z-review-98434-39mtrb`: PASS, no blocking findings.
- The commit-bound review `20260914T015003Z-review-98434-ru92q7` found two P1 lifecycle findings; both are fixed in the current source fingerprint and require a new exact review.
- `20260914T015515Z-review-98434-wj4iwq`: FAIL, orphan cleanup candidate-set and exact process-identity findings; fixed in the current source fingerprint and superseded by the next review.
- `20260914T020534Z-review-98434-75bimj`: FAIL, crash-window child persistence and evidence-count reconciliation; fixed in the current source fingerprint and superseded by the next review.
- `20260914T021109Z-review-98434-2turzr`: FAIL, orphan marking and pre-readiness state findings; fixed in the current source fingerprint and superseded by the next review.
- `20260914T021516Z-review-98434-0736sj`: FAIL, persisted entry-path identity was not yet bound in the architecture map; fixed in the current source fingerprint and requires a new exact review.
- `20260914T022602Z-review-98434-twrlow`: FAIL, launcher-loss/orphan cleanup and exact child identity had no deterministic regression coverage; fixed by adding dead-launcher cleanup and mismatch-preservation tests, and requires a new exact review.
- `20260914T023440Z-review-98434-2sidh1`: FAIL, dead-launcher restart skipped descendant recovery, launcher PID identity trusted persisted owner state, and configured Work reread mutable projection identity; fixed in the current source fingerprint and requires a new exact review.
- `20260914T024653Z-review-84505-9praxp`: FAIL, child cleanup matched entry/config without a per-launch child identity; fixed by binding each child argv and persisted state to launcher startToken, and requires a new exact review.
- `20260914T025643Z-review-84505-f8b5wb`: FAIL, startup readiness/validation error could be persisted as `stopped` by supervisor cleanup; fixed by registering failure before cleanup, and requires a new exact review.
- `20260914T030216Z-review-84505-c0f3dk`: FAIL, pre-readiness child persistence omitted startToken/generation and could leave an unmanageable live child after launcher loss; fixed by persisting the complete child identity before readiness, and requires a new exact review.
- `20260914T030706Z-review-84505-vmm8ip`: FAIL, config reload dropped daemon startToken, and candidate scope/evidence records were inconsistent; fixed by retaining startToken through reload and binding the actual paths/467-test receipt, and requires a new exact review.
- `20260914T031329Z-review-84505-l9u59u`: FAIL, the declared install/restart operations lacked exact installed-entrypoint evidence; the current candidate has now passed `pnpm smoke:installed` with the receipt recorded in `validation-evidence.md`, and requires a new exact review.
- `20260914T034500Z-review-r6-runtime-install-replay`: PASS, Codex controller found no P0/P1 findings for the exact uncommitted candidate after the installed-entrypoint replay. Review evidence is retained under `.agent-collab/review/20260914T034500Z-review-r6-runtime-install-replay/`.
- `20260914T035200Z-review-r6-commit-bound`: FAIL, a failed launcher could retain a live owned supervisor PID and start a duplicate supervisor. Fixed by validating and stopping the persisted supervisor before descendant recovery, with a regression in `runtime/local-process.spec.ts`; this candidate requires a new exact review.
- `20260914T040000Z-review-r6-final-commit`: FAIL, the spawn-to-readiness window persisted `pid=0`, leaving a live detached supervisor unrecoverable after caller loss. Fixed by persisting the spawned PID immediately and adding a startup-window regression; this candidate requires a new exact review.

MCPX workspace discovery did not list this repository (`workspace not found: AgentTeams`);
the project CLI and Git hooks were used once with the same commands and exact receipts,
without bypass flags.
