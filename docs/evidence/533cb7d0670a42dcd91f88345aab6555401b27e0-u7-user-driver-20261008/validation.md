# U7 user-driver acceptance — round 12 candidate (v6)

This directory is the tree-bound evidence for the round-12 U7 user-driver candidate.
Every number below was produced by the primary integration owner on this exact
candidate and this exact installed package. The driver receipt in
`u7-user-driver.receipt.json` is the machine record.

## Candidate identity

| item | value |
|---|---|
| head commit | `5bae61472f21d88543fba3a61832e0cb37566b19` |
| tree | `533cb7d0670a42dcd91f88345aab6555401b27e0` |
| base commit | `4aed787041f387e090e141d276b41eab877278e6` (`origin/main`) |
| source state | `committed` |
| worktree | `/Volumes/Intel/playground/agentteams/u7-user-driver-20261006` |
| installed package | `generated/modules/teams-source/lib` |
| package mode | `final` |
| package files | 191 |
| package `content_sha256` | `af1daf791760002cc7f95c8cb3162578fe5491d1c2da025b7a1a81f647f6cc37` |

`git status --porcelain` in the candidate worktree held only the allowed untracked
`.appsdk/records/` entry. `candidate.indexed_tree_hash` equals `candidate.tree_hash`,
so the receipt binds a committed source state.

## Round-12 fixes carried by this candidate

1. **I5 — `observedAcceptedSourceHash` serialization.** `runtime/local-config.ts`
   no longer publishes an empty-string `observedAcceptedSourceHash` for an
   unaccepted provider observation; four real-TOML tests cover the case.
2. **I6G — BB09 config-interaction completion and BB10 primary/backup order.**
   BB09 now waits, inside one poll, for the refresh success notice, the re-enabled
   Refresh action, no live-region error, the selected Agent and the visible model,
   then proves the bind action is enabled before the real click. BB10 now switches
   the canonical provider to primary first and keeps the RCC binding as the
   distinct backup, preserving the `+2` accepted revision.
3. **I6H — BB09 Agent-policy refusal precondition.** An Agent that never accepted
   config has no durable accepted slice while its config view still reports
   revision 0. The refusal scenario now sends `expectedRevision: 0` explicitly and
   compares the raw durable slice presence and revision before and after, instead
   of requiring a pre-existing accepted slice.

## Mapped gates on this candidate

| gate | command summary | result |
|---|---|---|
| `teams-provider-config-effective` | 8 spec files incl. `runtime/managed-config-owner`, `managed-config-live`, `managed-opencode-session`, `agent-process`, `console-config`, `local-config`, `control-protocol/console-api`, `scripts/blackbox-user-mvp` | 8 files, **133 tests passed**, exit 0 |
| `teams-console-directory-discovery` | 7 spec files incl. `console-hub`, `console-runtime`, `console-wire`, `blackbox-user-mvp`, `ui/teams-console/tests/{api,model,render}` | 7 files, **68 tests passed**, plus `pnpm typecheck`, `pnpm build:runtime`, `pnpm smoke`, exit 0 |

Raw logs: `gates-build-admission.log`.

## Packaging and lifecycle admission

| step | result |
|---|---|
| `pnpm build:governance` | exit 0 |
| `pnpm lifecycle:admission` | exit 0, `{"ok":true,"candidate":"5bae61472f21d88543fba3a61832e0cb37566b19","artifact_hash":"sha256:03f24d4ea7827582890b9b3c9fa00a521125e8bd8bc3b69339fc8597083afa04"}` |

The package receipt was read **after** admission. It reports `mode=final`,
`source_state=committed`, head `5bae6147…`, tree `533cb7d0…`, 191 files, and
`content_sha256 = af1daf79…`.

## Installed black-box acceptance

Both runs used the same installed package directory listed above.

| run | command | window | result |
|---|---|---|---|
| focused | `--case BB06,BB09,BB10` | 11:08:12 → 11:10:11 | BB06 passed, BB09 passed, BB10 passed, exit 0 |
| full | `--case all` | 11:11:28 → 11:24:43 | **BB01–BB14 all passed**, exit 0 |

Machine receipt (`u7-user-driver.receipt.json`):

```
candidate      {head_commit 5bae6147…, base_commit 4aed7870…, tree_hash 533cb7d0…,
                indexed_tree_hash 533cb7d0…, source_state committed}
installed_package {content_sha256 af1daf79…, mode final, version 0.1.0}
cases          14
exit           {code 0, failed [], unverified []}
```

Focused logs: `focused/focused.log`, `focused/focused.receipt.json`.

### BB09 evidence of interest

- `cases/BB09/browser-config-bind-preclick.json` —
  `{"selectValue":"bb-console-model","bindDisabled":false,"liveRegion":"Refresh models: accepted by Agent","liveRegionIsError":false}`.
- `cases/BB09/browser-config-before.json` accepted revision `0` →
  `cases/BB09/browser-config-after.json` accepted revision `1`.
- `cases/BB09/agent-policy-refusal/agent-policy-refusal.json` — real public command
  with `expectedRevision: 0`, HTTP `200`, `ok: false`, `error.code: FORBIDDEN`,
  `accepted_revision_before/after: null`, `accepted_slice_present_before/after: false`,
  observation source `target Agent durable internal store`.
- `cases/BB09/static-binding/` — the isolated static-binding sub-scenario ran and
  produced its own start, projection, browser and cleanup records.

## Residual gaps and out-of-scope findings

- Two-provider installed verification inside BB10 exercises the real canonical
  provider. If that provider is unavailable at run time the case reports
  `unverified`; this run did not take that branch.
- Product gaps observed while driving U7 but not fixed in this round: the default
  relay `requestTimeoutMs` is 1000 ms against a real `camo start` of roughly 4 s;
  `agentteams status` prints capabilities comma-separated; a second `config.apply`
  against a live managed OpenCode child fails and is masked as
  `config: owner fence record already exists`. These are recorded as findings, not
  as accepted behaviour.

## Scope statement

This evidence covers the source-level and installed-black-box acceptance of the
round-12 candidate. It does not replace the independent architecture review, the
milestone review, or the phase-memory closeout for the round.
