# Evidence index — round-12 U7 user-driver candidate (v8)

Candidate head `3bb440df74e5cf61d95b95de01eb633bf0854b34`, tree
`ebf96741e47d36be6c3f5a4bbd0e653d9789d084`, installed package
`generated/modules/teams-source/lib` with `content_sha256`
`5442d61ac6eb6d44658067ba946bb7d569c6b9c6ee508fc77d46bac5866596a2`.

All 14 cases passed in one `--case all` run (20:13:28 → 20:27:43). Case status and
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
| BB07-execution-failure | 14 | `bb07-fault-open.json`, `bb07-fault-query.json`, `bb07-failure-stop.json`, `bb07-failure-restart-start.json`; the sub-scenario of case BB07 that interrupts a real in-flight search |
| BB08 | 17 | `bb08-restart-start.json`, `bb08-query-retained.json`, `bb08-final-stop.json` |
| BB09 | 114 | `browser-config-bind-preclick.json`, `agent-policy-refusal/agent-policy-refusal.json`, `static-binding/` |
| BB10 | 80 | `boundary/boundary-result.json`, `boundary/baseline.json`, `boundary/manual-selection.json`, `boundary/stale-cas.json`, `boundary/invalid-credential.json`, `boundary/no-failover.json`, `bb10-canonical-turn.json`, `bb10-switch-session.json` |
| BB11 | 14 | `bb11-compile-baseline.json`, `bb11-compile-arc-error.json`, `bb11-compile-missing-operator.json` |
| BB12 | 13 | `bb12-console-start.json`, `bb12-config-apply.json`, `bb12-projection.json`, `bb12-session.json` |
| BB13 | 13 | `failure.json`, `recovery.json`, `graph-change.json`, `artifact-change.json`, `evidence-delete.json` |
| BB14 | 11 | `bb14-start.json`, `bb14-duplicate-start.json`, `bb14-status.json` |

## Companion records

| path | content |
|---|---|
| `u7-user-driver.receipt.json` | machine receipt for the `--case all` run (candidate identity, installed package hash, per-case status, exit summary) |
| `package-receipt.json` | frozen `final` package receipt read after lifecycle admission |
| `run.log` | `--case all` stdout and window |
| `focused/bb07-execution-failure.receipt.json` | focused BB07 execution-failure replay on this candidate, run before the final acceptance run |
| `focused/four-case-3173585.receipt.json` | four-case replay (`BB07`, `BB09`, `BB10`, `BB13`) on the previous candidate `3173585`, which closed the first two driver defects |
| `retries/transient-bb10-timeout.receipt.json` | the first acceptance attempt on this package, which failed BB10 with a provider timeout |
| `retries/bb10-single-case-probe.receipt.json` | the successful single-case BB10 probe that followed |
| `gates-build-admission.log` | mapped gates, `pnpm verify`, `pnpm build:governance` and `pnpm lifecycle:admission` |
| `validation.md` | candidate identity, carried fixes, gate results and evidence of interest |

## Case-internal sub-scenarios

BB09 and BB10 keep their sub-scenarios inside the parent case, so the case count
stays at 14: BB09 carries `agent-policy-refusal/` and `static-binding/`; BB10
carries `boundary/` for the four deterministic boundary results next to the real
two-provider acceptance records.

BB07's execution-failure sub-scenario writes its records into its own directory
`cases/BB07-execution-failure/`. That directory is a sub-scenario of case BB07 and
is not a fifteenth case; the receipt lists 14 cases and `--list` prints 14.
