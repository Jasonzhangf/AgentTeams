# 01e3223 owned PID-reuse fixture teardown

This unit changes only the PID-reuse test in `runtime/local-process.spec.ts`.
Product runtime and the public stop contract are unchanged.

Base: `bca92a0411a2a787bf0189896623e7eb08124586`.
Validated test source SHA256:
`fed699c332e484c8441601d34a90bdc7427796033653ed52e7bb4e57ed80224e`.
The validated source-only index tree is
`9a3a8e0aaa7e537b674d9e7db67e147458ad8819`.
This evidence publication adds no product or test input changes. The 45-test,
typecheck, runtime-build and graph results remain valid for those exact bytes.
The final candidate tree and independent review are recorded in the external
unit receipt after evidence publication.

## Cause and intervention

The original full committed admission recorded 575 passing tests and one
`ENOTEMPTY` failure in this fixture. A real-process control experiment retained
the fake PID after SIGTERM. Public `stopLocalProcess` rejected `STALE_OWNER` and
the genuine launcher remained alive. Restoring the saved genuine fixture owner,
calling the generation-bound public stop and awaiting its process exit made the
same control pass. This proves the teardown hole. It does not prove the precise
interleaving in the historical `ENOTEMPTY` failure.

The final fixture reaps its fake child, restores only its saved launcher input,
stops its genuine launcher and waits for its exit before removing the fixture
directory. Cleanup errors remain visible. Original assertions, startup timeout
and test timeout are preserved. Temporary causal probes were removed.

## Author validation

`validation-receipt.json` binds commands, exits, source hash and raw output.
`mapped45.json` preserves the full raw public start/status/stop replay: 45 passed,
zero failed. Typecheck, runtime build and daemon-stop topology validation also
exited zero. This is a test-only change; no product install or restart applies.

The first independent gcm review failed only because it could not find the
external validation receipt. This publication fixes that evidence visibility
gap. It does not turn that failed review into PASS.

The external unit directory is
`$HOME/.codex/task-evidence/agentteams/receipts/01e3223-pid-fixture-cleanup-20261005/`.
It retains the original full admission failure, controlled red/green logs and
patches, author receipts and run notes. Merge, push and cleanup are still pending.

## Current-main composition, 2026-10-05

The sections above describe historical candidate `70fcd539` on base `bca92a0`.
This candidate starts from remote main `84ea11dd8b91dda61083029c9820ffe82c6283ec`.
It applies the same PID-reuse teardown delta and preserves the delivered capture
reader fix. Product runtime, dependency lock and graph remain unchanged.
`current-main-validation.json` contains the new full raw 45-test, typecheck,
runtime-build and graph-validation results. All four commands exited zero.
Its source hash binds the current composition; the historical whole-file hash
does not bind this candidate. The controlled causal delta is unchanged and its
prior red/green result is reused only for that delta. Installation and restart
remain inapplicable to this test-only fix. Current independent review, formal
admission, main integration, push and owned cleanup are pending.
