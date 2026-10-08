# U7 User Driver Black-Box Validation

Task: `docs/goals/teams-agent-handoff-20261005.md` §1 — final BB01–BB14 on one installed package
Date: 2026-10-07 (America/Los_Angeles)
Status: `INSTALLED PUBLIC-ENTRY EVIDENCE / TREE-BOUND / 14 of 14 PASSED`

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree, not the
commit that publishes the receipt.

| Fact | Value |
|---|---|
| Candidate the driver ran against | `50bf7aa1788294943ad032809bf2fed14e213e3c` |
| Candidate tree | `07b4a73eceb1b90e448433c626c2fe233c17a4bc` |
| Base (merged U6 `main`) | `25bcd8cab11d24e5b31371923ed5111caed6e8e8` |
| Receipt `source_state` | `committed` |
| Receipt `indexed_tree_hash` | `07b4a73eceb1b90e448433c626c2fe233c17a4bc` (equals the commit tree) |
| Installed pack `content_sha256` | `4c2acc563a37268e48a614664fe8e3fa3cb0af7f5fb37991361dcfc550a14d59` |
| This evidence directory | added by a `docs/`-only commit whose parent is that commit |

A receipt cannot live inside the commit it binds. The publishing commit changes no product path;
verify that one fact:

```text
$ git diff --name-only 07b4a73eceb1b90e448433c626c2fe233c17a4bc HEAD | grep -v '^docs/'
```

Nothing is printed when the claim holds.

## What was run

One invocation of the user driver produced every result in this directory:

```text
$ pnpm build:governance
$ node scripts/blackbox-user-mvp.mjs --case BB01,BB02,BB03,BB04,BB05,BB06,BB07,BB08,BB09,BB10,BB11,BB12,BB13,BB14 \
    --receipt …/u7-user-driver.receipt.json
```

The driver builds nothing itself. It installs the staged pack from
`generated/modules/teams-source/lib` and drives every case through **public entrypoints only** —
the installed `agentteams` CLI, the installed Console HTTP ingress, and the real local
bridge/daemon sockets. It reads no private state to decide pass/fail. Case evidence is under
`cases/<ID>/`.

Pack provenance is recorded in `package-receipt.json` (a verbatim copy of
`generated/modules/teams-source/package-receipt.json`, mtime `2026-10-07T18:16:19`, after the
candidate commit time `2026-10-07T18:13:39-07:00`). It binds the same `head_commit`, `tree_hash`,
`indexed_tree_hash`, `source_state`, `content_sha256`, `mode: final` and `version: 0.1.0` as the
receipt, and records the staged SDK runner
(`sdk.runner_sha256 = ded4e98ffea9541c980d9652d2a06a6ecfc16229c8d038bf57e33206562d92f5`,
build receipt `runtime/dagpipe/.build/build-Xvmq9q/build-receipt.json`).

## Result on this one package

`u7-user-driver.receipt.json` records `exit = { code: 0, failed: [], unverified: [] }`; all 14
cases passed.

| Case | Owner | Gate | Result |
|---|---|---|---|
| BB01 | U1+U5+U7 | installed package lifecycle and Console assets | passed |
| BB02 | U2+U7 | config.toml-only two-daemon bridge discovery | passed |
| BB03 | U3 | real browser service lifecycle and capacity | passed |
| BB04 | D3/U4 | installed public Work submit and query | passed |
| BB05 | U3+U4 | installed Work rejection matrix | passed |
| BB06 | U3+U4 | persistent browser Work capacity | passed |
| BB07 | D3/U4 | installed Work unknown and recovery query | passed |
| BB08 | U2+U4 | installed config generation and stale rejection | passed |
| BB09 | U5 | installed Console lifecycle and offline Work | passed |
| BB10 | U2+U6 | installed explicit provider/model session | passed |
| BB11 | D3/U4 | installed SDK Work and compile negatives | passed |
| BB12 | U6 | installed Session message tool permission cancel | passed |
| BB13 | D4/U7 | existing lifecycle store failure recovery invalidation matrix | passed |
| BB14 | U1+U7 | failed start stop and owned resource cleanup | passed |

Notable case content on this package:

- **BB03** drives the real Camo binary (`/opt/homebrew/bin/camo --version` → `0.4.10`) through the
  installed public Work entry: `work open` for a browser context, `work query` for its state,
  `work close`, plus the disabled/missing-configuration and file-search paths (`cases/BB03/`).
- **BB05** drives the rejection matrix through the same installed entry: undeclared operation,
  wrong target, stale generation, unauthorized submit, and the legal submit control
  (`cases/BB05/`).
- **BB06** drives persistent browser Work capacity with four concurrent opens, queries and closes
  plus an over-capacity request (`cases/BB06/`).
- **BB10** drives the installed explicit provider/model Session, including a config switch and
  restart (`cases/BB10/`).
- **BB12** drives the installed Session end to end — create, send, real tool call, permission
  decision, cancel — through the installed Console ingress (`cases/BB12/`).
- **BB13** drives the project lifecycle adapter in a fresh clone of the candidate commit; see the
  dedicated section below.

## BB09: public-entry-only remediation

The previous review round reported `driver-public-entry-boundary` (P2): BB09 imported the internal
module `generated/runtime-lib/runtime/local-process.js` to read a typed Console status. That helper
and both `typed:` result fields are deleted. BB09 now asserts only externally observable facts of
the installed CLI:

- `console status` exits non-zero and prints `Console control socket is unavailable`;
- `console start` exits non-zero and prints `Console is disabled`;
- the zero-child runtime row.

Both facts come from the installed `agentteams` binary, which is the only public entry the package
declares (`package.json` has no `exports` map; `bin = { "agentteams": "./cli/agentteams.mjs" }`).

## BB13: passed, with an honest record of the retries

BB13 clones the repository at the candidate commit, symlinks `node_modules`, and drives
`scripts/lifecycle-adapter.mjs` through nine phases: `failure`, `recovery`, `idempotent-entry`,
`reentry`, `source-change`, `graph-registry-change`, `config-change`, `artifact-change`,
`evidence-delete`. Each invalidated phase re-runs the project's own `pnpm verify`
(`pnpm test && pnpm typecheck && appsdk guide compile && appsdk compile && pnpm smoke && appsdk verify`),
so one BB13 run performs five full `pnpm verify` runs, each including the 678-test regression with
real Chrome, real OpenCode and real npm pack/install.

On this candidate the gate was executed ten times:

| Attempt | Result | Failed cases |
|---|---|---|
| 1–9 | `exit.code = 1` | `BB13` (attempts 3 and 9 also `BB10`) |
| 10 | `exit.code = 0` | none — this is the receipt published here |

Per-attempt receipts and driver logs are in `history/`. The observed failure mode was fixed-deadline
timeouts in pre-existing real-substrate specs: for example attempt 1's `cases/BB13/failure.json`
records `numFailedTests=2, numPassedTests=676` with the two failures at 10185 ms and 10076 ms,
which is exactly the `startupTimeoutMs = 10_000` bound in `runtime/managed-opencode.ts`. The same
two specs pass in 2.9 s / 4.2 s in the worktree. A control run of the same suite in a clone with
the adapter's exact environment failed on a *different* pair (`cli-executor.spec.ts`,
`agent-process.spec.ts`), so the failing set moves with machine contention rather than being a
deterministic defect of the candidate or of one spec.

The machine was shared with other agents' CPU-bound work throughout (four `rccv3` servers at
roughly 90 % CPU each, `obscura-host`, Docker, WindowServer; load average 13.3–31.4). Attempt 10
ran after 101 stale processes owned by this task were reaped and load had fallen to about 18.

Honest statement of what this does and does not show:

- The candidate passes the complete BB01–BB14 gate on one package.
- The retry history shows the gate is **load-sensitive**; one passing run does not prove the
  underlying timeout sensitivity is fixed. No product or test code was changed for this delivery,
  and none of the fixed deadlines were widened, skipped or relaxed.
- The claim recorded here is "consistent with machine resource contention", not "the unique root
  cause is proven": there was no controlled load intervention.

## Verification-map lag (reported, not edited)

`docs/architecture/verification-map.json` still describes `teams-work-sdk-installed` and
`teams-package-install` as `partial`, and their notes still speak of the driver matrix and the
final installed user acceptance as pending. That text is now stale, because this directory
contains the actual installed public-entry evidence for the full matrix. The map was deliberately
**not** edited in this change: it is a governance input to the lifecycle adapter's fingerprint, so
relabelling it would change the adapter's input while the receipt here was produced with the
existing map. Completion is claimed from the receipts in this directory, not from a status label.

## Boundaries of this evidence

- **Pack content hash is not byte-reproducible.** `pnpm build:governance` recompiles the
  `runtime/dagpipe` runner, so two builds of one commit produce different pack hashes. Candidate
  equivalence is judged by `git diff --name-only <receipt tree> HEAD | grep -v '^docs/'` printing
  nothing, and the receipt binds the pack it actually installed.
- **Superseded receipts.** Earlier receipts under `generated/u7-driver/` (`bb03`, `bb05`, `bb06`,
  `bb10-r1`, `bb12-r1`, `bb10-12-combined*`, `no-regression-r1`) were produced while the worktree
  was `staged`, not `committed`, and against earlier candidates. They are not admissible and are
  not republished here. Only `u7-user-driver.receipt.json` in this directory is the final
  same-package receipt. The earlier published directory
  `docs/evidence/5ce84fb5942411d00d2bc2eec53177b43dbe6aed-u7-user-driver-20261007/` is superseded
  by this one; see its `superseded.md`.
- **`session.cancel` in BB12** recorded a confirmed reconciliation on the real substrate, which is
  the cross-check for the U6 multi-match tightening delivered in
  `docs/evidence/fcb52bdb1b22a9060016805d842a17a9e100981b-u6-installed-session-20261007/`.
- **Known product gaps found by this driver, reported not fixed.** They are outside the U7 driver's
  own scope and are listed in the phase memory and the final report:
  1. a capacity refusal reaches the public `work open`/`work request` result as
     `requestState: "failed"` + `workClosure: "retained"` with no public error code, while the typed
     `RESOURCE_EXHAUSTED` reason exists only in the provider ledger;
  2. the default relay `requestTimeoutMs` (1000 ms, `runtime/local-config.ts:1466`) is shorter than a
     real `camo start` (~4 s), so a confirmed browser delivery through the relay is impossible by
     default;
  3. `agentteams status` prints capabilities comma-separated, so a declaration that itself contains
     a comma is not unambiguously parseable;
  4. a second `config.apply` against a live managed OpenCode child fails, and the failure is masked
     as `config: owner fence record already exists` while the underlying stop() reports
     "Managed OpenCode exit remains unconfirmed".
- **Pre-existing relay anomaly.** The local relay exits with code 0 without a stop request in some
  runs. The driver tolerates exactly that message in the stop path while still asserting that owned
  pids are gone, ports are closed, and the terminal state is reached. Two runs left orphaned agent
  and OpenCode children; each was terminated by explicit PID. This is a pre-existing product
  behaviour, recorded here rather than fixed in the driver.

## Index

`evidence-index.md` maps every path in this directory to its source, and records the MVP-level
criteria (design admission, installed real DAGpipe Work, graph coverage classification, U1–U7)
with their original evidence locations.
