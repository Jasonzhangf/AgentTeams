# First-wave library integration candidate

Base: `364ceec10ec03b6d652b820ffdb8fbf0bdf9967c`. Primary integration tree:
`playground/n2-integration-20260906`. Candidate imports preserve the original
worker source commits without merging them to main yet:

- C1 `5747a7f0c9909653bacf3b2e283897126d36a14a`: config store and OpenCode adapter.
  AGY `agentteams-c1-luna-provider-20260906-r4` passed the worker candidate.
- W1 `665b65a`: local Work/resource ledger and recovery proof API.
  AGY `teams-w1-20260906-review-4` passed the worker candidate.
- N1 `7b63f824ac5228a17395c590e942aaa5ad776fb6`: real WSS Relay.
  AGY `20260906T052500Z-review-69576-luna-relay` passed the worker candidate.

Primary adds `network/wss-connection.ts`, `network/relay-login.ts` and the
admission schema. TLS open is distinct from server admission; byte transport
does not interpret business content. Explicit limits bound unread messages,
socket buffering and admission duration. Errors close failed connections;
no automatic request replay or provider failover is introduced.

Real local integration in `network/wss-connection.spec.ts` uses the actual
Relay server and two clients: login, scoped directory, grant/offer, separate
data sockets, bidirectional opaque text/binary. Business fields named like
control messages remain exact bytes. There is no Console in this flow.

The combined validation reported 36 files / 205 tests with root typecheck,
library builds and AppSDK compile/verify. `scripts/runtime-smoke.mjs` separately
loads packaged JavaScript directly in Node and proves real TLS admission and
directory access. It closes its own client/server and removes temporary certs.
Logs remain in this tree's owned playground: `n2-real-relay.log`,
`n2-first-wave-validation.log`, `n2-packaged-smoke.log` and subsequent final
candidate validation. These are local source/library claims, not deployment.

Primary reviewed the concrete earlier failures: identity tuple collision,
unbounded relay buffers, resource-ID owner mismatch, late apply overwriting
runtime state, and mutable config aliases. Worker regressions and source fixes
are present in this candidate. Recovery still requires real daemon-exclusive
execution and exact process-exit proof; it does not infer death from lock age.

Not completed: actual HTTP provider catalog client, managed OpenCode apply,
daemon process entrypoint and lifecycle, Work executor binding, desktop/mobile,
public NAT/direct replay. Commit/merge and resource closure remain pending at
this review receipt; those states require later delivery evidence.

## Whole-candidate review receipt

AGY controller task `agentteams-first-wave-integration-20260906-r1` returned
`state=completed`, `verdict=pass`, `error=null`, with no findings. Original
review evidence is retained in the candidate tree's `.agent-collab/review/`.
The reviewer summary counted 44 suites; the actual project regression report
counts 36 test files and 205 tests. The latter is the authoritative count.

Primary factual review: PASS, `ai-reviewed`, `human-unreviewed`. The reviewed
source matches the validated candidate. This receipt and its project-memory
entry add verified observations only; no product source changed after review.
Source tests, packaged local runtime smoke, engineering review and future
deployment acceptance remain distinct claims.
