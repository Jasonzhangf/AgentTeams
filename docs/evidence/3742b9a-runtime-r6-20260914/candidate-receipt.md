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

## Changed paths

```text
runtime/agent-process.ts
runtime/local-config.spec.ts
runtime/local-config.ts
runtime/local-process.spec.ts
runtime/local-process.ts
runtime/local-supervisor.ts
runtime/local-two-agent.spec.ts
docs/evidence/3742b9a-runtime-r6-20260914/base.txt
docs/evidence/3742b9a-runtime-r6-20260914/candidate-receipt.md
docs/evidence/3742b9a-runtime-r6-20260914/validation-evidence.md
```

## Candidate fingerprint

```text
source diff sha256: 320972c0e0a45040cdb5b562ddb14f2af12623a1fed6e3022114b8731cba303c
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

MCPX workspace discovery did not list this repository (`workspace not found: AgentTeams`);
the project CLI and Git hooks were used once with the same commands and exact receipts,
without bypass flags.
