# Evidence index — round-12 U7 user-driver candidate (v7)

Candidate head `4aeaf50465978ef724d60b9bd251a249a8a7b8f1`, tree
`eeda4da6be0266ed7a9e1ff8cdfdf982826d0076`, installed package
`generated/modules/teams-source/lib` with `content_sha256`
`da4850c281e5b09c70bf57d0da090fd24d17bf30920e8750192f118431efd49d`.

All 14 cases passed in one `--case all` run (14:20:47 → 14:34:56). Case status and
error text are in `u7-user-driver.receipt.json`; this file only indexes the raw
records under `cases/`.

| case | files | representative records |
|---|---|---|
| BB01 | 9 | `bb01-start.json`, `bb01-status.json`, `bb01-stop.json`, `bb01-stopped-status.json` |
| BB02 | 8 | `bb02-start.json`, `bb02-status.json`, `bb02-stop.json`, `bb02-stopped-status.json` |
| BB03 | 27 | `bb03-browser-open.json`, `bb03-browser-query.json`, `bb03-disabled-config.json` |
| BB04 | 12 | `bb04-start.json`, `bb04-status.json`, `bb04-query-a.json`, `bb04-query-unknown.json` |
| BB05 | 17 | `bb05-init.json`, `bb05-config.json`, `bb05-legal-submit.json`, `bb05-stale-generation.json` |
| BB06 | 29 | `bb06-config.json`, `bb06-close-1.json`, `bb06-close-2.json`, `bb06-close-4.json` |
| BB07 | 16 | `bb07-open.json`, `bb07-query-recovered.json`, `bb07-final-stop.json` |
| BB08 | 17 | `bb08-restart-start.json`, `bb08-query-retained.json`, `bb08-final-stop.json` |
| BB09 | 114 | `browser-config-bind-preclick.json`, `agent-policy-refusal/agent-policy-refusal.json`, `static-binding/` |
| BB10 | 79 | `boundary/boundary-result.json`, `boundary/baseline.json`, `boundary/manual-selection.json`, `boundary/stale-cas.json`, `boundary/invalid-credential.json`, `boundary/no-failover.json`, `bb10-canonical-turn.json`, `bb10-switch-session.json` |
| BB11 | 14 | `bb11-compile-baseline.json`, `bb11-compile-arc-error.json`, `bb11-compile-missing-operator.json` |
| BB12 | 13 | `bb12-console-start.json`, `bb12-config-apply.json`, `bb12-projection.json`, `bb12-session.json` |
| BB13 | 13 | `failure.json`, `artifact-change.json`, `config-change.json`, `evidence-delete.json` |
| BB14 | 11 | `bb14-start.json`, `bb14-duplicate-start.json`, `bb14-status.json` |

## Companion records

| path | content |
|---|---|
| `u7-user-driver.receipt.json` | machine receipt for the `--case all` run (candidate identity, installed package hash, per-case status, exit summary) |
| `package-receipt.json` | frozen `final` package receipt read after lifecycle admission |
| `run.log` | `--case all` stdout and window |
| `focused/focused.receipt.json` | machine receipt for the same-package `--case BB06,BB09,BB10` run |
| `focused/focused.log` | focused run stdout and window |
| `focused/cases/` | focused-run raw records (BB06, BB09, BB10) |
| `gates-build-admission.log` | mapped gates, `pnpm verify`, `pnpm build:governance` and `pnpm lifecycle:admission` |
| `validation.md` | candidate identity, carried fixes, gate results and evidence of interest |

## Case-internal sub-scenarios

BB09 and BB10 keep their sub-scenarios inside the parent case, so the case count
stays at 14: BB09 carries `agent-policy-refusal/` and `static-binding/`; BB10
carries `boundary/` for the four deterministic boundary results next to the real
two-provider acceptance records.
