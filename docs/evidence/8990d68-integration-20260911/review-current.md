# 8990d68 exact review receipt

- Candidate: `b3f4cb71b0dc14270fd9f8668dccb33eec18c446`
- Base: `9943593de922af0e5e883fb38881bc6215f495db`
- Reviewer: independent primary review after GCM read-only review attempt
- Scope: `control-protocol/endpoint-ref.ts`, `control-protocol/endpoint-ref.spec.ts`, `control-protocol/work-wire.spec.ts`, `agent/work-resource.ts`, `agent/work-resource.spec.ts`
- Result: **PASS**

The candidate keeps Endpoint identity, lifecycle, revision, capability, operation, and
resource admission in typed control state. `admitWorkEndpointReference` rejects a
non-active lifecycle after owner/scope/revision admission. `proposeWork` verifies that
every capability resource is mounted by the admitted Endpoint and keeps the stored
reference immutable for later request operation binding. Existing proposal idempotence
returns the exact accepted proposal before mutable discovery is reread. Work request
control rejects Endpoint/session metadata while business payload remains arbitrary JSON.

Focused validation on the exact integration tree:

```text
vitest run --config vitest.config.ts \
  control-protocol/endpoint-ref.spec.ts \
  control-protocol/work-wire.spec.ts \
  agent/work-resource.spec.ts \
  runtime/agent-work-client.spec.ts \
  runtime/agent-process-config.spec.ts
=> 5 files, 44 tests passed
git diff --check => passed
appsdk verify => {"ok":true,"project_id":"agentteams","stage":"contract_bound"}
pnpm build:runtime => passed with temporary package dependency links removed afterward
tsc --noEmit => passed with temporary package dependency links removed afterward
```

The full regression remains separately blocked by existing daemon readiness/listener
failures; it is not evidence against this source-only candidate. Public Relay, NAT,
provider live, Console-offline, and restart replay remain MVP acceptance gates and are
not claimed by this receipt.
