# Daemon execution candidate — 2026-09-06

Base: `6a073b0e56c5911a4b219f38f69ae53f941e8333` (PR #8).
Owner worktree: `playground/daemon-execution-20260906`.
This incremental candidate implements local executable Relay/Agent entries and
authenticated Work execution. It does not complete the first-release goal.

## Candidate validation

- `playground/execution-candidate-tests.log`: 48 files, 280 tests passed.
- `playground/capability-schema-typecheck.log`: root and adapter typechecks passed.
- `playground/execution-candidate-{guide,compile,smoke,verify}.log`: official
  AppSDK compilation, packaged smoke and verification passed.
- `playground/agent-process-final-replay.log` and
  `playground/agent-process-run-7Nx26F/evidence.jsonl`: primary executed a real
  installed copy of the latest compiled Agent entry. All 56 source/installed
  files matched and remained stable. Full hashes are retained in the receipt.

The installed copy executed real fixed-root `rg` Work over local TLS Relay,
closed Work, restarted and read back the completed result. A fixed test CLI
returned exit 7 and stdout/stderr; typed error details survived the wire and
durable restart readback. No TypeScript runtime transformation was used.
Runtime dependencies come from the installed workspace (`ws` 8.21.3); this is
not a dependency-free distribution.

Actual child exits: 96858 SIGTERM/code 0; 96861 idle SIGKILL; 96865 SIGINT/code 0;
96868 failure run SIGTERM/code 0; 96896 failure readback SIGINT/code 0.
Temporary installed runtime and dependency link were removed. Evidence and
test data remain owned by this worktree until archival. Shared Camo was untouched.

## Correctness findings resolved

- Invalid local Work input previously left a deadline that later closed a usable
  channel. Red/green: `playground/work-channel-input-red.log`,
  `playground/agent-process-channel-green.log`.
- CLI error output was lost at executor/ledger boundaries. Typed
  `ServiceError.execution` now preserves it; persistence and wire share the
  protocol validator. Red/green: `playground/cli-error-fidelity-{red,final}.log`.
- Publication could mutate the directory before readback capacity was admitted.
  The correlated slot is now reserved first. Red/green:
  `playground/publish-capacity-{red,green}.log`.
- Stop could wait for a stalled data handshake timeout. The network owner now
  cancels connecting/established data sockets and waits for actual closure.
  Red/green: `playground/handshake-abort-{red,green}.log`.
- CLI discovery returned only generic object schemas. The CLI owner now
  publishes parameter/result declarations; actual process directory assertions
  prove their availability. Red/green: `playground/capability-schema-{red,green}.log`.

N1's bounded second source review found the publication/cancellation fixes
resolved with no new concrete findings. It did not run tests or review the
entire candidate. Whole-candidate AGY admission and Git delivery are pending.

Whole-candidate engineering review subsequently completed:
`agentteams-daemon-execution-20260906-r1`, controller `completed/pass`, findings
empty. Primary inspected its scope: CLI, Agent Host, protocol, network, Agent
ledger, server, runtime and governance including newly staged files. Its generic
network description mentions direct channels; the candidate evidence proves
Relay only, not direct support. The original review remains unchanged in
`.agent-collab/review/agentteams-daemon-execution-20260906-r1/`.
Git delivery remains pending. This paragraph records the later review result.

## Remaining first-release work

Unconfirmed active Work after a crash explicitly prevents startup until trusted
reconciliation; active browser recovery is not implemented. Managed OpenCode
apply, Console backend/UI integration, durable relationships, direct/public
NAT and real-phone validation remain pending. Local TLS and idle restart
evidence must not be used to claim these requirements complete.

AppSDK executable resources drifted during development. Official `appsdk init`
refreshed the owned bundle after a snapshot; project AGENTS was preserved.
Snapshot and exact digest are recorded in `playground/run-notes.jsonl`.
Collab remains pending without a live tmux peer; no claims were fabricated.
