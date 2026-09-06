# Explicit current Session selection

Base: `7d171e8c4b61f42d01bd32065baa576f321e663f`.
Primary owns Console host selection semantics and affected design/maps.
No worker-owned runtime/config/agent files changed.

The existing Console projected sessionIds[0] and dispatched prototype messages
to sessions[0]. New tests first failed in three cases (`red.log`): a list does
not establish current selection, a second explicitly selected Session must win,
and the first listed Session must not receive the message.

One read-only Agent Host port, readCurrentSession(agentId), now supplies explicit
selection or unknown. One helper validates the selected ID against the target
Agent list for projection and dispatch. Absent selection does not create a
default; invalid selection and host-read failures propagate. No UI-owned store
or duplicate selection policy was introduced.

Full pnpm verify passed (`validation.log`): 33 files / 143 tests, typechecks,
library builds, Guidance/AppSDK compile/verify, compiled Console smoke.
The HTTP relation-communication regression exercises the actual Console server
with local upstream fixtures: the second selected Session receives the request;
after selection becomes unknown, the request fails with no additional prompt.
This is local protocol/product-ingress evidence, not a real OpenCode inference,
daemon binding, mobile or cross-device acceptance.

Primary factual and code review: PASS, AI-reviewed, human-unreviewed.
Both implicit-first branches were deleted and the selection owner remains the
Agent Host. Real daemon selection lifecycle and removal of prototype Console
relay remain N2/I1 work. Source merge and resource closure are pending at this
record; test servers close in finally. The worktree is retained for review and
delivery, with raw evidence to archive before closure.
