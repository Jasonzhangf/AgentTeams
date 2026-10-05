# Work continuation policy validation

Issue: `c38ba70`. Base: `be6faf18a1bea5610412a578124bbf5e454ab435`.
Source scope is `runtime/dagpipe/host.ts` and `runtime/dagpipe-work.spec.ts`.
The graph and registered Operators are unchanged.

The public `WorkRequestIntentControl` has no `policyRevision`. Its graph
continues an existing provider-owned Work and has no admission node. The host
validator required that field anyway. The test helper spread admission control
into continuation control and hid the mismatch. A real public SDK consumer
with the exact typed continuation failed before host/provider effects.

The fix keeps policy validation on one-shot and open admission. Continuation
still validates business, demands, identity and generation. The test helper
now constructs its own continuation contract. Admission policy negative tests
remain and assert no effects. No policy is guessed or added to socket control.

`author-validation.json` retains raw RED/GREEN, the 22-test real SDK/network
consumer, typecheck, build, graph validation and the execution receipt. The
continue execution returns the real beta-file search result. It performs
findProvider/open/request/dispose and has no extra propose. Provider ledger
ownership, persistent Work count, requests and resource close are checked by
the public consumer. Worker approximate note times are not receipt timestamps;
parent observation timestamps and raw outcomes bind the facts.

This is a source library fix. Installed user CLI Work and final SDK package
remain separate delivery obligations. Current artifact admission, independent
review, main integration, push and cleanup are recorded in the external issue
directory under the current HOME task evidence. Full MVP remains incomplete.
