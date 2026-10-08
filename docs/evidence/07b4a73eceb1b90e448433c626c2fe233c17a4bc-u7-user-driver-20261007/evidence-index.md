# Evidence index — U7 round 11

This file maps the paths inside this directory back to the paths the run actually wrote, and it
indexes the MVP-level criteria of `docs/goals/teams-agent-handoff-20261005.md` §1 to their original
evidence locations.

Nothing in this file re-states a result that the receipt or a case file already carries. Where a
criterion's evidence is incomplete, that is written as a gap.

## 1. Path mapping (where each published file came from)

| Published path | Source path | Notes |
|---|---|---|
| `u7-user-driver.receipt.json` | `/tmp/u7-retry/attempt-10.receipt.json` | byte-identical (`cmp` clean) |
| `run.log` | `/tmp/u7-retry/attempt-10.log` | driver stdout for the passing run |
| `cases/BB01…BB14/` | `/tmp/u7-retry/1791428708404-76969/cases/BB01…BB14/` | 225 files, `diff -qr` clean |
| `package-receipt.json` | `generated/modules/teams-source/package-receipt.json` (candidate worktree) | pack provenance, mtime `2026-10-07T18:16:19` |
| `history/attempt-1…9.receipt.json` | `/tmp/u7-retry/attempt-1…9.receipt.json` | failed attempts, unmodified |
| `history/attempt-1…9.log` | `/tmp/u7-retry/attempt-1…9.log` | driver stdout of the failed attempts |
| `validation.md` | written for this publication | human-readable summary and boundaries |

The receipt itself still carries its original absolute `evidence_dir`. It was not rewritten: no
candidate SHA, tree, timestamp, exit code or status inside it was changed.

## 2. MVP completion criteria (handoff §1) and their evidence

The contract (`docs/goals/teams-agent-handoff-20261005.md:18-20`) requires: design admission,
installed real DAGpipe Work, remaining behavior-graph coverage classification, U1–U7, final
BB01–BB14 on one installed package, independent milestone PASS, remote `main` receipt, applicable
phase memory, owned-resource cleanup, and a clean `main`.

| Criterion | Evidence location | State |
|---|---|---|
| Design admission | `docs/goals/teams-user-delivery-plan.md:75-76` (D1 `94b4633` tree `da94159b` r2 PASS, D2 `35ca32b` tree `5acf841b` r2 PASS), `:59` (U6 design r8 PASS on `3f3e3dd`), `:115`; external `receipts/d1-design-20261003/delivery-receipt.json`, `receipts/d2-sdk-20261003/delivery-receipt.json` | present; see gap G5 |
| Installed real DAGpipe Work | `docs/evidence/4b6c377-local-public-work-20261005/notes.md` (installed public Work submit/query on a staged final pack); external `receipts/public-work-receiver-fix-20261005/final-r15/installed-runtime-smoke.receipt.json`; this directory's BB04/BB05/BB06/BB07/BB11 cases | present; see gap G2 |
| Behavior-graph coverage classification | `docs/design/teams-behavior-contracts.md:95-108`, `docs/goals/teams-user-delivery-plan.md:128-140`, `docs/design/teams-local-console-v1.md:420-436`, `docs/design/teams-relay-link-lifetime.md:69-71` | 15 of 15 graphs classified (5 executable Work graphs, 10 static-governed); see gap G6 |
| U1–U7 | `docs/goals/teams-user-delivery-plan.md:75-80`; U1 `7739da4`, U2 `228de8f`, U3 `2d8c744`, U4 `a27d3f4`/evidence `1835d20`, U5 merge `2644e43`, U6 `25bcd8ca`; U7 = this directory | U7 delivered by this change; see gap G4 |
| Final BB01–BB14 on one package | `u7-user-driver.receipt.json`, `cases/` | 14 of 14 passed, `exit.code = 0` |
| Independent milestone PASS | milestone review of the merged `main` | not part of this directory; see `validation.md` boundaries |
| Remote `main` receipt | `git ls-remote origin refs/heads/main` after the merge | recorded in the task notes, not here |
| Applicable phase memory | `/Users/fanzhang/.codex/task-evidence/agentteams/local-mvp-active-20261003.md` | refreshed in a later step of this task |
| Owned-resource cleanup | task notes and cleanup receipt | later step of this task |
| `main` clean | `git -C <root> status --porcelain` | later step of this task |

## 3. Known gaps recorded by this round's observation

These are stated so that no reader treats a label as proof.

- **G1 — verification-map labels lag.** `docs/architecture/verification-map.json` still marks
  `teams-work-sdk-installed` and `teams-package-install` as `partial`, and the
  `teams-work-sdk-installed` note still says the BB04–BB07/BB11 driver matrix and the final
  installed user acceptance are `PENDING`. That text is now stale. The map was deliberately not
  edited: the lifecycle adapter folds the map into its governance fingerprint, so relabelling it
  would change the adapter input while the receipt here was produced with the existing map. See
  `validation.md` "Verification-map lag".
- **G2 — in-repo installed-Work replay is a failure.** `docs/evidence/4b6c377-local-public-work-20261005/public-cli-replay/`
  records `step-1..5` all `exit=1` (`listen EPERM`, local config unreadable) because the sandbox
  denied listening. The successful installed Work smoke receipt lives outside the repository at
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/public-work-receiver-fix-20261005/final-r15/installed-runtime-smoke.receipt.json`.
  This directory's BB04/BB05/BB06/BB07/BB11 cases are the in-repo installed public-entry evidence
  for the same capability on the final package.
- **G3 — `installed_content_sha256` recording omission.** 11 of the 14 cases record
  `installed_content_sha256`, and all 11 equal the receipt's
  `4c2acc563a37268e48a614664fe8e3fa3cb0af7f5fb37991361dcfc550a14d59`. BB02 and BB14 install the
  tarball but omit the field; BB13 installs no package by design. This is an omission in the
  receipt, not a mismatch.
- **G4 — U3 evidence directory is thin.** `docs/evidence/9b84aaa-u3-browser-relay-current-20261004/`
  contains only `notes.md`, whose status is `AUTHOR_VALIDATION_PASS; PRIMARY_COMMIT_PENDING`, and
  `docs/goals/teams-user-delivery-plan.md:80` records that U3 has no full product review. The U3
  browser path is exercised end-to-end by BB03 on the final installed package in this directory,
  but the U3 stage record itself is not self-closing. The same is true of
  `docs/evidence/u5-console-lifecycle-20261005/`, which contains only `notes.md`.
- **G5 — D1 in-repo notes stop before the PASS line.**
  `docs/evidence/d1-behavior-contracts-20261003/run-notes.md` ends at `revision-validation`; the
  authoritative r2 PASS is recorded in `docs/goals/teams-user-delivery-plan.md:75` and in the
  external delivery receipt.
- **G6 — two graphs have no recorded validate output.** 13 of the 15 files under
  `docs/design/dagpipe/graphs/` have recorded `dagpipe graph validate` output in existing evidence.
  No record was found for `console-observe.graph.json` and `relay-link.graph.json`. The graphs were
  not changed by this round, so no new validation was run.
- **G7 — BB13 retry history.** The complete gate passed on the tenth attempt; attempts 1–9 failed
  with `BB13` (attempts 3 and 9 also `BB10`). See `validation.md` "BB13: passed, with an honest
  record of the retries" and `history/`. The claim recorded is "consistent with machine resource
  contention"; the unique root cause is not proven, and no code, deadline or assertion was changed.
- **G8 — pack content hash is not byte-reproducible.** `pnpm build:governance` recompiles the
  `runtime/dagpipe` runner, so two builds of one commit produce different pack hashes. Equivalence
  between this evidence and the merged `main` is judged by
  `git diff --name-only 07b4a73eceb1b90e448433c626c2fe233c17a4bc HEAD | grep -v '^docs/'` printing
  nothing, plus the tree binding inside the receipt.

## 4. What this directory does not claim

- It does not claim the milestone review passed.
- It does not claim the MVP is complete.
- It does not claim BB13 is stable; it claims one complete passing run on the bound package and
  records nine earlier failing runs.
- It does not re-execute or re-verify any U1–U6 stage evidence; those entries are references.
