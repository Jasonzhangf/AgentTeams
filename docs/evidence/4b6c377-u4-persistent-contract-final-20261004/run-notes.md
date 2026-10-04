# U4 persistent operation contract correction

Owner: Desktop primary (design only). Base: 26f12ec3ea92175cc8d9900459450490b4a71745.
Worktree: /Volumes/Intel/playground/agentteams/u4-persistent-contract-final-20261004.

The independent r7 review returned FAIL with one P1 at local Work design line 687:
connect.operation is one string, so restricting every persistent request to it
contradicts BB06a's context.create/navigate/snapshot/context.destroy chain.
Original formal result is retained outside the worktree under
task-evidence/agentteams/receipts/u4-persistent-design-20261004-r7.

Correction: one-shot retains its fixed connect operation. Persistent connect
selects initial provider/capability/version and open intent; later requests carry
the immutable original binding and explicit per-request operation/full demands.
The original provider declaration/policy/ledger decides admission. No config
schema, resolver, ledger, scheduler, product code or graph topology is added.
BB06a now explicitly requires unchanged config bytes throughout the chain.

Pending: static design validation, fifth code-correction independent review,
integration/push, memory and owned cleanup. No executable or installed Work claim.

2026-10-04T07:43:45.430496+00:00 / design validation | PASS: five official static graph validations, seven changed JSON documents parsed, both Markdown fences balanced, diff check clean. | Base 26f12ec; product code unchanged | Independent r8 exact design review next; installed Work remains pending.
