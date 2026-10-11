# D05 closure run notes — 2026-10-11

This directory records the D05 closure black-box driver and command evidence.
The driver is intentionally source-tree LAN evidence: it starts two real
`agentteams --serve` daemons, one OpenCode engine and one DSH engine, both on
a real LAN listener and a real registry. It is not installed-copy, restart,
deployed-entrypoint, or cross-device evidence.

## Driver invocation

Run the LAN black box with Node TypeScript transform mode:

```bash
node --experimental-transform-types docs/evidence/acp-d05-closure-20261011/black-box-lan-two-engines.mjs
```

Plain `node docs/evidence/acp-d05-closure-20261011/black-box-lan-two-engines.mjs`
is wrong for this script because it imports `.ts` sources.

## Script correction in this closure

The earlier driver hunted for a durable `policy.denied` history record. That
assertion was wrong for the implemented host:
`agent-host/acp-host.ts` calls policy admission before appending
`request.dispatched`, and no code path records `policy.denied` in history.
The corrected driver keeps the declared wire and engine-side gates and instead
asserts:

- the refused method is returned as the single JSON-RPC error envelope
  (`-32000`, `data.code = CAPABILITY_DENIED`);
- the refused method produced no provider call anywhere in the run;
- the durable history contains no `request.dispatched` record for
  `session/set_config_option`;
- the durable history still contains the daemon's normal `initialize` record.

## Registry outage gate

The outage gate requires the DSH prompt after stopping the registry to return
a terminal `result.stopReason === "end_turn"` over the established LAN channel,
and requires the daemon stdout to report a degraded, non-online registration
state. It is not satisfied by merely receiving any frame.

Current status in this worker run: **INCOMPLETE at the declared outage gate**
until a retry after external DSH provider `503 no_healthy_account` returns a
terminal prompt result. The failed attempts prove the channel stayed alive and
the provider returned an engine/HTTP error frame, but they do not satisfy the
declared “second prompt succeeds” gate.

## Other command results observed in this worker run

- D05 focused suite: `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts control-protocol/teams-connection.spec.ts`
  - exit 0, 9 files, 73 tests.
- `pnpm exec vitest run --no-file-parallelism runtime/acp-serve.spec.ts`
  - exit 0, 1 file, 26 tests.
- `pnpm exec vitest run --no-file-parallelism runtime/registry-process.spec.ts runtime/registry-registration.spec.ts network/registration-client.spec.ts`
  - exit 0, 3 files, 20 tests.
- `pnpm exec vitest run --no-file-parallelism cli/agentteams.spec.ts`
  - exit 0, 1 file, 30 tests.
- Full D04 registry suite:
  - exit 0, 6 files, 75 tests.
- `node --experimental-transform-types docs/evidence/acp-d05-network-20261010/isolated-transport-observation.mjs`
  - exit 0, `OBSERVATION PASSED: 23 checks.`
- `node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs`
  - exit 0, `BLACK-BOX PASS`.
- `node docs/evidence/acp-d03-serve-20261010/black-box-serve-dsh.mjs`
  - exit 1 in an earlier worker run: the real DSH provider returned
    `503 no_healthy_account` (provider availability, not an assertion failure).
  - Re-run at lead integration on the same tree: exit 0, `BLACK-BOX PASS: one
    daemon + one real DSH engine child, verified derived route, real prompt, real
    cancel, explicit-PID stop, owned DSH home removed.` The earlier 503 was
    transient provider availability, now resolved.
- `pnpm typecheck`
  - exit 0.
- `pnpm build:runtime`
  - exit 0.
- Five-map validation:
  - all five `docs/architecture/*.json` parse;
  - no duplicate JSON keys observed by `object_pairs_hook`;
  - no duplicate `gate_id` observed;
  - no dangling `required_gates` observed.

## Lead integration run (2026-10-11, same tree)

The two-real-engine LAN run is now green end to end:

```bash
node --experimental-transform-types docs/evidence/acp-d05-closure-20261011/black-box-lan-two-engines.mjs
# EXIT=0
# 91 `ok:` assertion checks, 1 `obs:` line
# BLACK-BOX PASS: two real engines on one real LAN listener, real registry
# directory, real negotiation, real prompts, isolation, unknown outcome,
# method blacklist, registry outage.
```

The registry-outage gate is the one that closes D05: after
`registry stop --config <path> --generation 1`, a second `session/prompt` on the
already-established channel returned `end_turn`, and the daemon printed
`registration state=reconnecting attempts=2 reconnects=0`. The registry pid was
gone and every local, LAN and registry port was free at the end.

### Driver defects fixed at integration (they blocked the run, not the product)

1. The overall deadline used `setTimeout(...).unref()` and only set
   `process.exitCode`, so the watchdog could never end the process. A run
   survived 16m48s past the 900s deadline with no children left, and the next
   run leaked a registry pid for 1h03m. The timer now reaps every recorded pid
   (SIGTERM, then SIGKILL) plus the registry through its own service entry, and
   then `process.exit(1)`; the timer is no longer `unref`'d.
2. A *passing* run also hung after printing `PASS`, because the stopped daemons
   leave sockets and timers behind and the event loop never drains. The driver
   now flushes stdout and exits with its own verdict after the `finally` reap.

Both were proven by observation: the daemon history for the hung run already
contained `dsh-prompt-2` followed by `result.received outcome=completed`, so the
product had done the right thing and only the driver failed to finish.

### Assertion removed

`the daemon recorded the refusal as a durable policy denial` was removed. It can
never pass: `agent-host/acp-host.ts` `dispatchToEngine` calls
`input.assertAllowed(...)` before `appendRecord(historyEntry('request.dispatched',
...))`, so a refused method writes no history record, and `policy.denied` exists
only as a field of the `AcpPolicySnapshot` shape assertion, never as a history
event. The declared gate is covered instead by the wire refusal
(`code -32000`, `data.code CAPABILITY_DENIED`), by the absence of any
`request.dispatched` record for the method, and by the surviving `initialize`
record.

### Resource receipt

Seven `d05-lan-blackbox-*` temp roots were removed after confirming no live pid.
One leaked registry daemon (pid 39905, alive 1h03m from an aborted run) was
stopped by explicit PID. After the final run: no `registry-process.js` and no
`runtime-lib` `acp-serve` process left, all ports free, owned DSH home removed.
No `pkill`, `killall`, `kill $(...)` or `xargs kill` was used.

### Driver self-cleanup (added on review)

The original driver reaped its daemons but never removed its owned temp root, so
every PASS left a `d05-lan-blackbox-*` root behind and the seven removals above
were manual. `black-box-lan-two-engines.mjs` now tracks `ownedRoot` and removes
it in `finally` once the daemons are reaped: a PASS prints
`cleanup: removed owned root <path>` and leaves nothing behind, while a failure
prints `cleanup: keeping owned root <path> for failure forensics` and retains it
so the daemon's own state can be read. The deadline path reaps and cleans before
`process.exit`, since `exit` skips `finally`. The same cleanup rule was already
in force in the D06 PART 2 drivers.

Two post-review runs of this driver failed at the `registry outage` step and were
not a product regression. Both retained roots show agent A (OpenCode) completing
every prompt while agent B (the DSH engine) failed every prompt with
`teams-workbuddy API error (503) no_healthy_account` — the DSH gateway pool was
unhealthy in this environment, so no prompt result could be produced with or
without the registry. Those runs reached 69 `ok:` assertions before the failure
and removed nothing; their roots were deleted by hand after confirming no live pid.
