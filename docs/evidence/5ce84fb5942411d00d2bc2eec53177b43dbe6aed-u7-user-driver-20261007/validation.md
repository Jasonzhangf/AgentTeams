# U7 User Driver Black-Box Validation

Task: `docs/goals/teams-agent-handoff-20261005.md` §1 — final BB01–BB14 on one installed package
Date: 2026-10-07 (America/Los_Angeles)
Status: `INSTALLED PUBLIC-ENTRY EVIDENCE / TREE-BOUND / 13 of 14 PASSED, BB13 ENVIRONMENT-BLOCKED`

> **Superseded 2026-10-07 (U7 round 11).** This directory is kept as history only. Its 13/14 result
> and its BB13 pin-mismatch blocker are no longer the current U7 evidence. The current evidence is
> `docs/evidence/07b4a73eceb1b90e448433c626c2fe233c17a4bc-u7-user-driver-20261007/`, which passes
> all 14 cases on candidate `50bf7aa1788294943ad032809bf2fed14e213e3c`. Nothing below has been
> rewritten. See `superseded.md` in this directory.

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree, not the
commit that publishes the receipt.

| Fact | Value |
|---|---|
| Candidate the driver ran against | `1ac7b920c62cd6c27637165b1dbac38d47818385` |
| Candidate tree | `5ce84fb5942411d00d2bc2eec53177b43dbe6aed` |
| Base (merged U6 `main`) | `25bcd8cab11d24e5b31371923ed5111caed6e8e8` |
| Receipt `source_state` | `committed` |
| Receipt `indexed_tree_hash` | `5ce84fb5942411d00d2bc2eec53177b43dbe6aed` (equals the commit tree) |
| This evidence directory | added by a `docs/`-only commit whose parent is that commit |

A receipt cannot live inside the commit it binds. The publishing commit changes no product path;
verify that one fact:

```text
$ git diff --name-only 5ce84fb5942411d00d2bc2eec53177b43dbe6aed HEAD | grep -v '^docs/'
```

Nothing is printed when the claim holds.

## What was run

One invocation of the user driver produced every result in this directory:

```text
$ pnpm build:governance
$ node scripts/blackbox-user-mvp.mjs --case BB01,BB02,BB03,BB04,BB05,BB06,BB07,BB08,BB09,BB10,BB11,BB12,BB13,BB14 \
    --receipt …/u7-user-driver.receipt.json
```

The driver builds the pack, installs it into an isolated short temporary root, and drives every
case through **public entrypoints only** — the installed `agentteams` CLI, the installed Console
HTTP ingress, and the real local bridge/daemon sockets. It reads no private state to decide
pass/fail. Case evidence is under `cases/<ID>/`.

`pnpm build:governance` exit 0, artifact `5bb801eb29b6100867b589105df578d260f9966e65390e8ccd4f2022a0d4576a`
(`run.log`).

## Result on this one package

`u7-user-driver.receipt.json` records `exit.failed = ["BB13"]`; 13 cases passed.

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
| BB13 | D4/U7 | existing lifecycle store failure recovery invalidation matrix | **failed — environment** |
| BB14 | U1+U7 | failed start stop and owned resource cleanup | passed |

Cases that were previously unverified and now pass on this package:

- **BB03** drives the real Camo binary (`/opt/homebrew/bin/camo --version` → `0.4.10`) through the
  installed public Work entry: `work open` for a browser context, `work query` for its state,
  `work close`, plus the disabled/missing-configuration and file-search paths
  (`cases/BB03/`).
- **BB05** drives the rejection matrix through the same installed entry: undeclared operation,
  wrong target, stale generation, unauthorized submit, and the legal submit control
  (`cases/BB05/`).
- **BB06** drives persistent browser Work capacity with four concurrent opens, queries and closes
  plus an over-capacity request (`cases/BB06/`).
- **BB10** drives the installed explicit provider/model Session, including a config switch and
  restart (`cases/BB10/`).
- **BB12** drives the installed Session end to end — create, send, real tool call, permission
  decision, cancel — through the installed Console ingress (`cases/BB12/`).

## BB13: environment blocker, not a regression

BB13 clones the repository at the candidate commit and runs the project's own `pnpm verify`
through the lifecycle adapter. That command runs
`pnpm test && pnpm typecheck && appsdk guide compile && appsdk compile && pnpm smoke && appsdk verify`.
It fails at the first `appsdk` step:

```text
PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0010:required_binary=appsdk-0.1.0010
```

- The installed binary is `appsdk 0.1.0011 (rust)` (`/Users/fanzhang/.cargo/bin/appsdk version`).
- `.appsdk/project.json` declares `sdk.version = "0.1.0010"` (line 281).
- No prebuilt `appsdk` 0.1.0010 binary exists on this machine.
- The same failure reproduces on the untouched base commit `e3ad473a` — see
  `appsdk-pin-mismatch-on-base.log`. It is therefore toolchain drift, not a regression of this
  candidate.
- Evidence: `cases/BB13/failure.json` (`pnpm verify failed with status 1`, full stderr including the
  pin-mismatch line), plus the clone/checkout/`which-pnpm`/worktree-status records.

BB13 is **UNVERIFIED**, not passed and not failed on its own merits. Restoring an `appsdk`
0.1.0010 binary or promoting the pin to 0.1.0011 is a version-promotion decision reserved for the
human, so this change does not touch `.appsdk/project.json`.

## Boundaries of this evidence

- **Pack content hash is not byte-reproducible.** `pnpm build:governance` recompiles the
  `runtime/dagpipe` runner, so two builds of one commit produce different pack hashes. Candidate
  equivalence is judged by `git diff --name-only <receipt tree> HEAD | grep -v '^docs/'` printing
  nothing, and the receipt binds the pack it actually installed.
- **Superseded receipts.** Earlier receipts under `generated/u7-driver/` (`bb03`, `bb05`, `bb06`,
  `bb10-r1`, `bb12-r1`, `bb10-12-combined*`, `no-regression-r1`) were produced while the worktree
  was `staged`, not `committed`, and against earlier candidates. They are not admissible and are
  not republished here. Only `u7-user-driver.receipt.json` in this directory is the final
  same-package receipt.
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
     a comma is not unambiguously parseable.
- **Pre-existing relay anomaly.** The local relay exits with code 0 without a stop request in some
  runs. The driver tolerates exactly that message in the stop path while still asserting that owned
  pids are gone, ports are closed, and the terminal state is reached. Two runs left orphaned agent
  and OpenCode children; each was terminated by explicit PID. This is a pre-existing product
  behaviour, recorded here rather than fixed in the driver.
