# D00 amendment A3 — engine instance on the connection context

Unit: `acp-l7-contract-20261013`. Worktree:
`/Volumes/Intel/playground/agentteams/acp-l7-contract-20261013`. Branch:
`codex/acp-l7-contract-20261013`. Base: `origin/main` `85df0a8`.

This milestone removes one contract blocker. It does not deliver the initiator.

## 1. The blocker, and the facts that decided it

`AcpChannelRef.engineInstanceId` is a required non-empty string
(`control-protocol/acp.ts`). `createTeamsSession` refuses an `acp.open` whose
`engineInstanceId` differs from the receiving daemon's own value with
`STALE_GENERATION` (`network/teams-session.ts`). No discovery surface carried that
value, so no remote initiator could build a legal `acp.open` at all.

The recorded gap proposed publishing the value on `AgentDeclaration`. I checked that
proposal against the code before acting on it, and the facts did not support it.

| # | Fact | Evidence |
| --- | --- | --- |
| F1 | The engine instance is generated per engine process: `` `${engine.kind}-${agent.daemon.id}-${randomUUID()}` `` | `runtime/acp-serve.ts:948` |
| F2 | `targetGeneration` is the constant `1` in the same serve path, so `engineInstanceId` is the only value that actually changes when the engine restarts | `runtime/acp-serve.ts:947` |
| F3 | The receiving side validates `targetGeneration` and `engineInstanceId` in one guard, then rebuilds both from local values before any host call | `network/teams-session.ts:156-163` |
| F4 | `teams.connection.context` already carries the responder's own `targetGeneration`, `capabilitiesRevision` and `policyRevision` | `control-protocol/teams-connection.ts` |
| F5 | The initiator already learns `expectedTargetGeneration` "from the directory/route", and the context must match it | `network/teams-negotiation.ts:69-70` |
| F6 | `AgentDeclaration` is a closed key set of identity and configuration facts: `identity`, `scopeId`, `revision`, `capabilities`, `routes` | `control-protocol/agent-services.ts`, `control-protocol/relay-codec.ts` |
| F7 | The responder emits the context frame with its own generation as `targetGeneration` | `network/teams-negotiation.ts:234-236` |
| F8 | `startTeamsNegotiation` already supports `side: 'initiator'`, but no production code composes it | `network/teams-negotiation.ts:255`; `network/teams-ingress.ts:28` states the ingress "never sends `acp.open`" |
| F9 | D00 amendment A1 had already added a field to this exact frame, and A2 had extended the control wire additively | `docs/design/teams-acp-daemon-config-v4.md` sections 11 and 12 |

F1 and F2 together show that the engine instance is the field that detects an engine
restart. F3 shows it is validated beside `targetGeneration`. F4 and F7 show the
context frame is the responder's live handshake assertion. F6 shows the declaration
is a replicated identity surface.

Conclusion: `engineInstanceId` is a connection-time fact, so it belongs on
`teams.connection.context`, beside `targetGeneration`. Publishing it on
`AgentDeclaration` would put a per-process random value into the replicated
directory, churn the declaration on every engine restart, and give one freshness fact
two sources.

## 2. The amendment

D00 amendment A3. The frame version stays `1`. It adds one required key to one v1
frame. The full clauses are in `docs/design/teams-acp-daemon-config-v4.md` section 13.

| Field | Frame | Source of truth | Parser rule |
| --- | --- | --- | --- |
| `engineInstanceId` | `teams.connection.context` | The responder's own live engine instance. | Required non-empty string. Missing, empty or non-string fails `INVALID_ACP_FRAME`. No default. |

A3 adds the publishing surface only. It does not weaken the guard: the receiving
side still refuses a different engine instance with `STALE_GENERATION` before any
host call, and the check is still re-applied on every `acp.frame`.

## 3. What changed

Eleven files, 168 insertions and 10 deletions.

| File | Change |
| --- | --- |
| `control-protocol/teams-connection.ts` | `TeamsConnectionContext.engineInstanceId`; parser closed key set; `assertText` so absence fails |
| `network/teams-negotiation.ts` | `TeamsResponderOptions.engineInstanceId` with a real-value check; emitted on the context; `TeamsNegotiationState.targetEngineInstanceId`; recorded in `acceptContext` |
| `network/teams-ingress.ts` | The production composer passes the same `input.engineInstanceId` it later validates in `createTeamsSession` |
| `control-protocol/teams-connection.spec.ts` | Context frame carries the field; absent, empty and non-string values are refused |
| `network/teams-negotiation.spec.ts` | The initiator records the value and can build an `acp.open` the parser accepts; a responder start without a real value is refused |
| `network/teams-ingress.spec.ts` | The real production composer publishes the value the session validates |
| `network/teams-session.spec.ts` | Fixtures carry the field; two existing cases now isolate their own failure mode |
| `docs/design/teams-acp-daemon-config-v4.md` | Section 13 records A3 |
| `docs/architecture/verification-map.json` | `teams-acp-d05-network` gains the A3 check; counts corrected to 77/77 |
| `docs/architecture/function-map.json` | The D05 bridge note records A3 |
| `docs/architecture/mainline-call-map.json` | The `acp-teams-network-v1` chain step and edge note record A3; count corrected to 77/77 |

Two existing cases in `network/teams-negotiation.spec.ts` and one in
`network/teams-session.spec.ts` had to gain the new field. Each of them asserts a
different failure mode, so leaving them short would have let them pass for the wrong
reason. They now isolate their own mode.

## 4. Evidence

This milestone reaches the **source**, **test** and **build** levels only.

| Level | Result | Command |
| --- | --- | --- |
| Source | The three production files changed as listed in section 3. No other frozen contract file changed. | `git diff --name-only control-protocol/` |
| Test (D05 gate) | 77/77 pass | `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts control-protocol/teams-connection.spec.ts` |
| Test (D06 gate) | 118/118 pass | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` |
| Test (full suite) | 1075 passed, 23 skipped, 1 file failed | `pnpm exec vitest run --no-file-parallelism` |
| Typecheck | pass | `pnpm typecheck` |
| Build | pass | `pnpm build` |
| Maps | all five parse as JSON | `python3 -c "import json; json.load(...)"` |

### 4.1 The one full-suite failure, and why it is not a defect

`cli/package-install.spec.ts` failed with
`receipt identity: staged product does not match the recorded index`. That check runs
`git diff --quiet` and fails when the tree has unstaged changes
(`scripts/receipt-identity.mjs`). It failed because this milestone was not yet
committed when the suite ran. It is a process gate, not a product defect.

On the committed candidate `0d41d51` the same gate passes 24/24:

```
pnpm exec vitest run --no-file-parallelism cli/package-install.spec.ts
Test Files  1 passed (1)
     Tests  24 passed (24)
  Duration  162.01s
```

That run also exercises the artifact receipt end to end: it packs and installs the
base tarball, produces the final SDK package, requires real installed start/restart
lifecycle evidence, and rejects an emitted receipt with tampered candidate identity.
The gate passes, so the receipt now names this commit rather than the previous one.

### 4.2 A first-run failure that was a missing build, not a regression

The first D06 run failed eight cases with
`START_TIMEOUT: control did not report running within 10000ms`. I did not accept that
as unrelated: `runtime/control-process.ts` imports `network/teams-ingress.ts`, which
this milestone changes. I checked it against the baseline instead.

- Baseline: `runtime/control-process.spec.ts` on the untouched main checkout at
  `85df0a8` passed 17/17.
- Cause: `generated/`, `console-host/lib` and `ui/teams-console/browser.js` are
  gitignored build outputs. A fresh worktree has none of them, and the control daemon
  spawns its entry from the built runtime.
- Fix: `pnpm build` in the worktree.
- After the build the same gate passed 118/118.

So the change did not cause that failure.

## 5. Mutation verification

Each new assertion was checked against a deliberate defect, and each defect was
caught by exactly the intended test and no other.

| Mutation | Caught by |
| --- | --- |
| The context emits a wrong engine instance (`'placeholder-mutation'`) | `publishes the responder engine instance so the initiator can name it on acp.open (D00 amendment A3)` — 1 failure, 21 other tests still pass |
| The parser drops `assertText(value.engineInstanceId, ...)` | `requires a non-empty engine instance on the context frame (D00 amendment A3)` — 1 failure, 8 other tests still pass |

Both mutations were reverted, and `grep` confirms no residue. The red run before the
implementation failed with `Teams connection context has unsupported field
engineInstanceId`, which is the intended failure mode.

## 6. Honest limits

- **The initiator is still not delivered.** `network/teams-ingress.ts` remains the
  responder composer and still never sends `acp.open`. A3 removes the blocker that
  made an initiator impossible; composing one is a separate milestone.
- **No installed-artifact, restart, deployed-entrypoint, browser or cross-device
  evidence.** This milestone reaches source, test and build only. Nothing here
  proves an installed copy or a live LAN channel.
- **`teams-acp-d05-network` stays `partial`.** A3 does not upgrade it.
- **No remote receipt and no merge.** The change is not integrated.
- The frozen contract was amended, so any peer built before A3 that omits the key is
  refused `INVALID_ACP_FRAME`. No v1 LAN peer was deployed, so no version bump is
  required.

## 7. Retained obligations

1. One independent review of this milestone before integration.
2. Compose the initiator, and bind `connection.connect` at
   `runtime/control-process.ts:818`, where `createControlOwner` is currently called
   without an `owner`.

The re-run of `cli/package-install.spec.ts` on the committed candidate is recorded in
section 4.1 and is no longer outstanding.
