# U3 Current Relay Real Camo Work

Status: AUTHOR_VALIDATION_PASS; PRIMARY_COMMIT_PENDING

Generated: 2026-10-04T22:10:00Z

## Result

The current SDK-bound real Camo browser Work chain passed through
`context.create -> navigate -> snapshot -> context.destroy -> Work close`,
with two distinct consumers holding contexts at configured capacity 2, a
third request rejected without a third context, and capacity restored after
confirmed destruction. Console was not in the path. Business/identity fields
were preserved by the existing U4 runner and provider ledger; U3 changed only
the test helper and map note after the pre-freeze candidate.

First divergence in the current U4 protocol was that
`WorkRequestIntentControl` requires `policyRevision`, while the U3 real-Camo
request helper omitted it. The helper now supplies revision `1`. This was a
test-harness fix; product adapter behavior and provider ledger semantics were
not changed.

## Checks

- `pnpm install --frozen-lockfile`: exit 0.
- `pnpm build:runtime`: exit 0.
- `pnpm --dir opencode-adapter build`: exit 0.
- Real Camo focused case: red at missing `policyRevision`, then passed 1/1
  after the helper fix.
- Four-file mapped regression: 4 files, 40 tests passed, no skips.
- `pnpm typecheck`: exit 0.

## Candidate And Evidence

- Base commit: `fe97c5284476c484769bb2945a5353190cca99f7`.
- Branch: `codex/u3-service-current-sdk-20261004`.
- U4 frozen library source: `f8ecfe35ca2662c0cb05071b9f89cdc1a5dc7229`.
- U4 independent review: pending; this note does not claim U4 PASS.
- Current worktree `git write-tree`:
  `93c3c68069a0dc93858d1d7a9e8384ce37d126c4`. This tree includes inherited
  staged U4, fixture, other-map, script, and notes paths, so it is not the
  primary author commit candidate. The primary must selectively commit only
  the exact U3 paths in the final receipt while leaving U4/fixture source and
  primary-only paths uncommitted by this worker.
- Raw command stdout/stderr/exit:
  `generated/u3-receipts/u3-service-current-sdk-20261004/raw/`.
- Pre-freeze external receipts:
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u3-browser-complete-20261004/real-camo-focused-r6.stdout.log`,
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u3-browser-complete-20261004/mapped-regression-r2.stdout.log`,
  and
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/15c7ef8-installed-service-fixture-20261004/installed-runtime.receipt.json`.

## Non-Claims

- Full public CLI/launcher/SDK installed Work remains `INCOMPLETE`.
- This task did not claim MVP, installed-browser completion, formal lifecycle
  admission, issue closure, or primary commit/merge/push.
- The earlier incomplete note ending at Camo `snapshot` was superseded by the
  already-delivered `--raw-dom` adapter fix and this current SDK-bound rerun.

## 2026-10-04 Exact Review r1 Repair

Base: `origin/main@258aaec34e331db9d4667ba84850d086741f1589`.
Inherited candidate tree: `21a0a9546cbe682cc97d6c21eb491a68782efb98`.
Branch: `codex/u3-review-fix-r2-20261004`.

The exact review found two author-repair gaps in the inherited U3 candidate:

1. `runtime/dagpipe-work.spec.ts` called `createCliWorkExecutor` without
   `services`. The public SDK harness now passes explicit `file-search` and
   `browser` intents with capacities matching its existing cases. No default
   service or fallback path was added.
2. `runtime/agent-process.ts` compiled `endpoint.services` for receiver-only
   roles. The receiver regression boots with declared services, invalid
   `/missing/rg`, and a missing search root. The role-bound repair now passes
   an empty service array for `role === 'receiver'`, so startup does not
   initialize or publish a local CLI adapter.

Raw evidence logs are under `generated/u3-r2-evidence/`:

- `red-dagpipe-work.log`: exact uncorrected failure
  `INVALID_INPUT: services must be an array`, 21/22 failed, first divergence
  at `runtime/dagpipe-work.spec.ts:187`.
- `red-receiver-declared-services.log`: exact pre-repair failure
  `INVALID_INPUT: searchExecutable cannot be inspected: ENOENT ... /missing/rg`,
  1/1 failed at `runtime/agent-process.ts:268`.
- `green-dagpipe-work.log`: 22/22 passed.
- `green-receiver-declared-services.log`: 1/1 passed; published and status
  capabilities are empty.
- `green-mapped-regression.log`: 4 files, 41/41 passed, including the real
  persistent Camo browser scenario through the current SDK graphs.

This note records author validation only. It does not claim review PASS,
commit, merge, push, installed MVP completion, or issue closure.

## 2026-10-04 r3 Author Corrections (independent r2 FAIL)

Base: `origin/main@258aaec34e331db9d4667ba84850d086741f1589`. Inherited index
tree: `1ccee6f986f8fc86ac39fb6faccd90a445a3a292`. Branch:
`codex/u3-review-fix-r3-20261004`. The independent r2 final is FAIL; this note
does not claim PASS.

Corrected the three r2 findings with new edits confined to the allowlisted
paths (`cli/agentteams.mjs`, `cli/agentteams.spec.ts`,
`runtime/agent-process.spec.ts`, `runtime/dagpipe-work.spec.ts`,
`docs/architecture/verification-map.json`, `docs/architecture/function-map.json`,
this note). No other inherited path changed.

1. `runtime/agent-process.spec.ts` now imports `LocalServiceIntent` from
   `./local-config.ts` (was the nonexistent `../local-config.ts`).
2. The public bare `agentteams work` command is blocked. It fails before any
   runtime load, launcher, socket or provider work with the explicit message
   `work is not implemented yet: no public new-request entry exists; agentteams
   work submit/query arrives with the U4 local-work seam` and exit 1. The stale
   `runLocalConfiguredWork` success dispatch is removed from the CLI; nothing
   was restored to v2/startup Work. `runtime/local-process.ts` is unchanged, so
   the legacy startup-receipt poll owner remains and its removal is pending for
   the primary. The U4 submit/query/open/request/close grammar is out of scope.
3. `runtime/dagpipe-work.spec.ts` no longer binds `/opt/homebrew/bin/camo`. Its
   execution is stubbed, and the browser declaration was not exercised by any
   case, so the harness is now `file-search` only with no machine-specific
   executable path. Real browser behavior/capacity stays in
   `runtime/agent-process.spec.ts`.

Tool-behavior limit for finding 1: the root `tsconfig.json` excludes
`**/*.spec.ts`, so `pnpm typecheck` cannot catch a spec import error; and vitest
erases type-only imports, so the stale path cannot fail the focused vitest gate.
A throwaway probe reproducing the stale `../local-config.ts` passed under
vitest, and direct `tsc` reported `TS2307: Cannot find module
'../local-config.ts'`. The fix is therefore verified by source inspection plus
the corrected-import resolution, not by an invented runtime red.

### r3 Checks (raw under receipt `.../u3-review-fix-r3-20261004/raw/`)

- `pnpm install --frozen-lockfile`: exit 0 (`attempt-00`).
- Focused `cli/agentteams.spec.ts runtime/dagpipe-work.spec.ts`: 2 files, 33/33
  passed, no skips, exit 0 (`attempt-09`).
- Mapped real-Camo regression `agent-host/cli-executor.spec.ts
  runtime/agent-process.spec.ts runtime/local-two-agent.spec.ts
  network/relay-client.spec.ts`: 4 files, 41/41 passed, no skips, exit 0,
  including the real persistent Camo browser scenario (`attempt-04`).
- `pnpm typecheck`: exit 0 (`attempt-05`).
- `dagpipe graph validate` for `agent-work`, `work-open`, `work-request`,
  `work-close`, `work-query`: all valid, exit 0 (`attempt-10`).
- `appsdk guide compile`: exit 0 (`attempt-11`). `appsdk compile`: exit 0
  (`attempt-13`).
- `pnpm smoke`: exit 0 (`attempt-14`). `pnpm smoke:installed` with
  `AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH` set to this receipt's
  `installed-runtime.receipt.json`: exit 0. It is re-run as the final gate once
  the tracked notes and stage allowlist are frozen, so the installed receipt
  binds the exact frozen worker tree; the definitive run's candidate tree and
  receipt sha256 are recorded in the external `candidate-receipt.json`
  (earlier runs: `attempt-15`, `attempt-17`).
- Public rejection on the same built runtime entry, from `/tmp` outside the
  repo: exit 1, message as above, duration 113 ms, no own launcher PID before or
  after, no `$HOME/.agentteams` side effect (`attempt-16`).

Changed paths versus the inherited index tree: only the six source/map paths
plus this note. This note records author validation only. It does not claim review
PASS, commit, merge, push, installed CLI MVP completion, or issue closure. Full
U3 BB03/BB06 and the installed CLI MVP remain OPEN.
# Current latest-main review evidence (2026-10-05)

Current delivery candidate composes the U3 source/fixture with main `85ed441` and the delivered immutable builder. The authoritative current candidate receipt, source-equivalence reuse receipt, raw compile/smoke/verify logs and installed BASE receipt are in `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u3-latest-main-final-20261005/`. Read `candidate-receipt.json` there for the final indexed tree and exact current artifact hashes. The verification-only author receipt and raw 33-test real-Camo regression plus 564-test zero-failure/pending full verification are in `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u3-current-builder-verify-20261005/receipt.json` and `raw/`. Source reuse is explicit: latest main differs only in four memory files, and this paragraph changes only the evidence index. Product, test, graph, map, dependency and config bytes remain equal to the fully tested candidate. Current package-bound compile and installed BASE are refreshed after the index paragraph is staged. Historical r3 review is not current review. No installed public CLI Work or final SDK package completion is claimed.
