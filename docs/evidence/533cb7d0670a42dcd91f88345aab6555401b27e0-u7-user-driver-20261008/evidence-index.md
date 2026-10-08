# Evidence index — round-12 U7 user-driver candidate

Candidate head `5bae61472f21d88543fba3a61832e0cb37566b19`, tree
`533cb7d0670a42dcd91f88345aab6555401b27e0`, installed package
`generated/modules/teams-source/lib` with `content_sha256`
`af1daf791760002cc7f95c8cb3162578fe5491d1c2da025b7a1a81f647f6cc37`.

All 14 cases passed in one `--case all` run (11:11:28 → 11:24:43). Case status and
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
| BB08 | 17 | `bb08-query-retained.json`, `bb08-restart-start.json`, `bb08-final-stop.json` |
| BB09 | 114 | `browser-config-before.json`, `browser-config-after.json`, `browser-config-bind-preclick.json`, `agent-policy-refusal/agent-policy-refusal.json`, `static-binding/` |
| BB10 | 31 | `bb10-config-apply.json`, `bb10-projection.json`, `bb10-canonical-turn.json`, `bb10-console-start.json` |
| BB11 | 14 | `bb11-compile-baseline.json`, `bb11-compile-arc-error.json`, `bb11-compile-missing-effects.json` |
| BB12 | 13 | `bb12-config-apply.json`, `bb12-projection.json`, `bb12-session.json` |
| BB13 | 13 | `config-change.json`, `artifact-change.json`, `evidence-delete.json`, `failure.json` |
| BB14 | 11 | `bb14-start.json`, `bb14-status.json`, `bb14-status-before-stop.json`, `bb14-duplicate-start.json` |

Supporting records in this directory:

- `u7-user-driver.receipt.json` — the driver receipt for the 14-case run.
- `package-receipt.json` — the final, committed package receipt the run consumed.
- `run.log` — start and end timestamps plus the driver's own summary line.
- `focused/focused.receipt.json`, `focused/focused.log` — the BB06/BB09/BB10 run.
- `gates-build-admission.log` — mapped gate runs, build, and lifecycle admission.
- `validation.md` — what was run, what passed, and what remains open.
