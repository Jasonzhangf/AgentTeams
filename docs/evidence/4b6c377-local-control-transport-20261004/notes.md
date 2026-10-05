# U4 local Work control transport notes

## Current candidate: latest-main r4

Base is `468111a785ca21bb398369ce10b865be973be61c`. Read
`current-r4-validation.json` for current source hashes and public-entry results.
The historical sections and earlier validation files below describe their named
inputs; they do not override this current candidate.

The latest main change only removes stale documentation workflows. The owning
socket source/test bytes, dependency lock and Work graphs are unchanged. The
15-case public socket replay remains valid; current artifact admission is
refreshed for this base before r4 review. This composition introduces no
product source intervention or new review verdict.

Both r2 decoder findings are fixed in the current source: `demands()` calls
`assertEnvelopeKeys(demand, ['resourceId', 'amount'], ...)`, and `work.query`
checks endpoint/capability-specific control keys before returning the selected
variant. The raw Unix socket negatives reject the extra fields before handler
dispatch. Earlier r3 FAIL repeated the pre-fix findings; it remains a failed
historical review and grants no integration permission. Current r4 must assess
these actual source lines and the new public replay, not inherit that verdict.

This unit delivers the socket library seam only. Installed CLI/launcher/receiver
assembly, final SDK pack and full MVP remain separate incomplete obligations.

## Historical author nodes

| Time | Node | Conclusion/status | Evidence | Input version/environment | Next |
|---|---|---|---|---|---|
| 2026-10-04 15:52 PDT | scope | worker scope, base and required source context confirmed | git HEAD/origin-main both `258aaec34e331db9d4667ba84850d086741f1589`; design sections 2/4/5/11, five Work graphs, `runtime/local-config.ts`, `runtime/dagpipe/host.ts`, owner skills read | base `258aaec`; worktree clean | run focused red for missing public module/API |
| 2026-10-05 00:01Z | inherited baseline | inherited stop author draft on base `258aaec` and indexed `5059807`; native/wrapper/shell evidence absent; socket-evidence was failed partial, not green | `git status --short --branch`; inherited staged diff; external `primary-drain-spotcheck.md`; prior failed command outputs only | worktree `/Volumes/Intel/playground/agentteams/u4-socket-contract-finish-20261005`; base `258aaec34e331db9d4667ba84850d086741f1589` | fix payload preservation and accepted-dispatch drain before maps |
| 2026-10-05 00:22Z | payload-loss red/green | `decodeLocalWorkControlRequest` attached validated `business` only to submit; open/request returned `undefined`. Fixed by validating required JSON before return and preserving null/0/false. | `pnpm exec vitest run runtime/local-work-control.spec.ts --reporter verbose`; generated `socket-evidence.json` | source seam; real Unix socket public consumer | fix close drain |
| 2026-10-05 00:22Z | disconnect-drain red/green | accepted handler could still be running after native server close; close now rejects new admission, drains every accepted dispatch, and only then settles. Test holds handler completion, disconnects peer, calls close without pre-await, and releases after proving close is pending. | focused socket spec green; `post-dispatch-peer-disconnect` evidence | real Unix socket public consumer | continue validation |
| 2026-10-05 00:25Z | payload and transport edge cases | Required JSON validated; malformed/unknown/extra/forbidden business fail closed; token/generation/receiver reject before handler; both query selections and all five modes round-trip; own socket cleanup and non-owned path preservation covered; overlong path rejected without product truncation/fallback. | focused socket spec 8/8 green; `socket-evidence.json` | source seam; short `/tmp` root only as fixture environment | run adjacent tests and governance |
| 2026-10-05 00:25Z | typecheck | Current source typecheck passes after removing the invalid listener `.path` dependency and using Node stdlib cleanup. Startup failure preserves `LOCAL_CONTROL_UNAVAILABLE`; no foreign path removal. | `pnpm typecheck` exit 0; `pnpm exec tsc --noEmit` exit 0 | candidate source tree | run governance |
| 2026-10-05 00:25Z | adjacent regression | local config and local process regressions pass with the socket seam change. | `pnpm exec vitest run runtime/local-config.spec.ts runtime/local-process.spec.ts --reporter verbose` 45/45 passed | candidate source tree | validate graphs/maps |

Limitations after this node:

- This evidence is source-library seam only. It does not install or exercise a CLI caller, receiver child IPC, or a real product daemon.
- `teams-work-sdk-installed` remains PENDING. Installed launcher/receiver assembly follows after this source delivery.
- Long-path evidence is bounded to the real Unix socket fixture and rejected explicitly; the product does not truncate, fallback, or add a second socket path.

Primary EOF repair, 2026-10-05: a real empty-peer disconnect left `onceEvent(data)`
unresolved and blocked close without entering business dispatch. The new empty,
partial-frame and idle-close cases all failed against the inherited product.
Native data/end/close/error framing now has one settlement and listener cleanup.
Close rejects new admission, removes idle peers, and drains admitted handlers.
Handler errors reach the correlated caller reply and retain the cause at shutdown;
startup cleanup failures preserve both causes in the error chain. Focused 12 and
mapped 57 real socket/config/process tests pass; typecheck and five graph
validations pass. Installed CLI/receiver/launcher assembly remains pending.

Current frozen candidate admission and raw gate results are recorded after
freeze in `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-eof-primary-20261005/candidate-receipt.json`.
The receipt binds the candidate tree, changed file hashes, exact raw command
exits and package identity. Its source behavior evidence includes
`eof.red.log`, `socket.green-r2.log`, `mapped.log`, and `red-fixture-cleanup.json`.
Read that external current receipt for artifact/smoke results; this tracked note
is not rewritten during final validation or review. No installed acceptance,
review PASS, merge, push, or complete MVP is implied by these source facts.

Latest-main continuation, 2026-10-05: the earlier receipt is historical. The
current base is `bca92a0411a2a787bf0189896623e7eb08124586`. The test receipt
producer now writes to its unique ignored `generated/u4-receipts/` directory,
so repeated real socket runs leave tracked source unchanged. The primary
observed 12 socket tests and 57 socket/config/process tests passing, with
typecheck passing. Current package gates, exact candidate identity and raw
logs are bound after freeze in
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-socket-latest-20261005/candidate-receipt.json`.
The adjacent capture-reader issue `76ccd32` remains separate; these tests do
not claim its fix. This slice supplies the public socket module only. CLI,
launcher and receiver assembly, installed Work and full MVP remain pending.

Current-main composition, 2026-10-05: base is now
`be6faf18a1bea5610412a578124bbf5e454ab435`. Both adjacent test-fixture fixes
are delivered. The socket source and its 12 tests retain the exact bytes of
the prior source slice. `current-main-validation.json` records the new real
57-test replay and typecheck, with their raw output and source hashes. Guide
compile also passed. The first artifact compile correctly rejected unstaged
product changes; staging the explicit owner paths resolved that admission
error. The receipt-only publication changes the index identity, so the final
artifact compile/smoke/verify is run after this evidence is frozen. Source
tests are reused for their unchanged inputs. Current review, committed
admission and remote delivery are recorded externally. This remains the
socket library slice; installed public Work and full MVP are incomplete.

Review correction and current composition, 2026-10-05: the independent r1
review rejected non-positive resource demands, inherited property names in
the decoder kind lookup, and an implicit result from reply delivery. The
socket owner now rejects amounts below one, uses an own-property lookup,
and returns `written` or `unconfirmed`. `written` means stream write only;
it does not prove remote receipt or consumption. Accepted Work still drains
after disconnect and is not cancelled by reply loss.

The fourth r1 finding belonged to the DAGpipe host. Issue `c38ba70` now has
remote main commit `9a95b63f3b44d7eb7f5cf4f53e40743b2f3bce0a`; typed
continuation does not acquire an invented policyRevision field. This socket
candidate is composed from that exact main. `author-r2-validation.json`
binds the corrected source, all three causal red/green pairs, the current
59-test public socket/config/process replay and typecheck. Earlier
`socket-evidence.json` and `current-main-validation.json` remain historical
receipts for their named source hashes; they are not evidence for this new
candidate. Fresh package gates and exact r2 review follow publication.
