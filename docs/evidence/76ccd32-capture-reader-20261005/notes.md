# 76ccd32 launcher capture reader

This unit changes only the existing capture reader in the startup-options test
in `runtime/local-process.spec.ts`. Product code is unchanged.

Base: `bca92a0411a2a787bf0189896623e7eb08124586`.
Validated source-only index tree:
`b84cc50e8600bc4ec9787a87833ec802f9ef71a5`.
Validated test file SHA256:
`d2200be4aa1cf3c1eca21f49e5896633baa004ca41f32364ec7d62d85e2833a4`.

The original reader waited 50 ms only after failed reads. A successful empty
read consumed an attempt immediately. Forty empty reads could therefore finish
before the real writer published output. The existing controlled-publication
experiment proves that reader failure. The fix applies the same existing
interval to successful empty reads. It keeps one reader, 40 attempts, the
1000 ms startup timeout, the 20000 ms test timeout and all three environment
assertions. It does not retry startup or change product lifecycle.

The exact timing or termination of the historical shell writer remains
unconfirmed. The controlled reader defect and its repair are the proven scope.

The first independent review required a green result under controlled
publication through the real public API. The new `public-causal.json` records
that pair. A real fixture publisher writes the actual forwarded environment
after two seconds. Both variants call `runLocalConfiguredWork` with the original
1000 ms startup deadline. The original reader fails on the empty file; changing
only its existing empty-read wait makes all three environment assertions pass.
A four-second publisher remains a failing negative case for the corrected
reader, which keeps its original bounded budget. These are diagnostic fixtures,
not product changes. All diagnostic source was removed after collecting evidence.

`validation-receipt.json` binds the actual focused test, 45-test public
start/status/stop regression, typecheck and runtime build, all exit zero.
JSON evidence preserves complete raw output. Evidence publication changes no
runtime, test, lockfile or configuration input; these results remain valid for
the exact source hash above. The unchanged daemon-start graph is validated
separately in `graph.json`.

External causal evidence, original failures and final candidate receipts remain
in `$HOME/.codex/task-evidence/agentteams/receipts/76ccd32-reader-minimal-20261005/`
and its referenced archived predecessor receipts. This fixture-only unit
requires no product install or restart. Independent review, committed admission,
main integration, push and worktree cleanup remain pending.
