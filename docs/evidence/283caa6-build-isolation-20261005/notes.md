# 283caa6 build isolation run notes

Base: `258aaec34e331db9d4667ba84850d086741f1589`
Author pre-stage index: `2bfd6939b7ffc19c178d78a8d3ec33c0e14d9f27` (base tree only;
not the changed candidate). The primary's exact candidate and command receipts
are retained under `$HOME/.codex/task-evidence/agentteams/receipts/283caa6-build-isolation-20261005/`.

Changed product paths:

- `runtime/dagpipe/build.mjs`
- `runtime/dagpipe-build.spec.ts`
- `docs/evidence/283caa6-build-isolation-20261005/notes.md`

File hashes at close:

- `runtime/dagpipe/build.mjs` `4367d58f8abb7d35d6200f68d197166482715cfcfead9e025f2fc2103323d599`
- `runtime/dagpipe-build.spec.ts` `7833125da94e61833b25fc33541f58b09eee9bee120519fc90f3bc7306c3507d`

Builder change: `runtime/dagpipe/build.mjs` allocates one stdlib `mkdtemp` root under
the existing ignored `runtime/dagpipe/.build` for every `buildRunner()` invocation.
It keeps the returned `receiptPath`, `runnerPath`, and `receipt` API and all receipt
hash semantics. Failures clean only the failed invocation root and rethrow the
original cause. Success artifacts remain until caller/worktree-owned cleanup.

Regression spec: `runtime/dagpipe-build.spec.ts` launches two independent native
Node consumers that call `buildRunner()` concurrently, verifies distinct immutable
runner and receipt paths and hashes, verifies source/SDK/graph/registry receipt
identity, and consumes each produced runner through its public `compile` CLI.
The spec removes only its own captured build roots and consumer temp directory.

Commands:

- `pnpm install --frozen-lockfile`: passed.
- `pnpm exec vitest run runtime/dagpipe-build.spec.ts --reporter verbose`:
  RED before fix with `EEXIST` on `runtime/dagpipe/.build/current/src`;
  GREEN after fix with 1 test passed.
- `pnpm typecheck`: passed.
- `pnpm exec vitest run runtime/dagpipe-build.spec.ts runtime/dagpipe-work.spec.ts
  --reporter verbose` with default file parallelism: passed, 2 files and 23 tests.
- `dagpipe graph validate` for `agent-work`, `work-open`, `work-request`,
  `work-close`, and `work-query`: all valid.
- `appsdk guide compile`: passed.
- `appsdk compile`: blocked by `scripts/receipt-identity.mjs`
  (`staged product does not match the recorded index`) in the author attempt.
  The author treated the no-commit instruction as also prohibiting staging.
  The primary stopped that writer and staged the explicit owned allowlist.
- `pnpm smoke`: not reachable because it reads the staged package receipt
  produced by `appsdk compile` in that failed attempt.

Primary re-entry: the unchanged final product bytes passed typecheck. The
author's pre-stage failures above are historical results. The current frozen
candidate's completed artifact compile and smoke results are in this explicit
external receipt, which is written after the staged tree is frozen:

`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/283caa6-build-isolation-20261005/candidate-receipt.json`

Read its `candidateTree`, `fileHashes`, `finalGates`, and `packageCandidate` to
check the reviewed tree, command exit codes, raw log paths/hashes, and generated
package identity. `primary-handoff.json` in the same directory preserves the
real concurrent RED/GREEN and default-parallel 23-test results. The primary
updates only that external receipt after freeze; this tracked note remains
unchanged during candidate validation and review. No installed CLI Work or
complete MVP acceptance is claimed.

Retained ignored build roots from `runtime/dagpipe-work.spec.ts`:

- `runtime/dagpipe/.build/build-JrwYMi`
- `runtime/dagpipe/.build/build-JbJe3U`

No map amendment was needed. `runtime/dagpipe/**` ownership and the `buildRunner`
edge are unchanged; the public API and receipt shape are unchanged.
