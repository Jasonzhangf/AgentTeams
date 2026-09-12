# Provider live milestone receipt

- Issue: `c5708f3`
- Candidate commit: `f9e90dbd3e721abed38cafb482f240de6e004137`
- Base commit: `f9e90dbd3e721abed38cafb482f240de6e004137`
- Candidate tree: clean worktree `codex/c5708f3-provider-live-milestone-20260912`
- Scope: explicit primary/backup provider dispatch, Agent/Relay configuration apply and readback, restart persistence
- Non-scope: automatic failover, inferred model IDs, public deployment, NAT-to-NAT/direct transport

## Discovery and explicit dispatch

RCC `GET http://127.0.0.1:4444/v1/models` returned HTTP 200 with empty `data` and
`models` arrays. The configured manual model remained `rcc-4444/gpt-5.5`.

Direct RCC dispatch used `POST /v1/chat/completions` with `model=gpt-5.5` and
`stream=false`; it returned HTTP 200, `finish_reason=stop`, and the exact marker
`teams-rcc-explicit-model`. The upstream response field `model=glm-5.3` was retained
as provider output and was not used as Teams configuration truth.

Credentialed GoAIChat discovery returned 18 entries, including the explicitly
configured backup `goaichat-openai/qwen3.8-max`.

## Agent and Relay apply/readback

The isolated live harness started a real TLS Relay and a real Agent process from this
candidate. The Agent received both provider instances and the following bindings:

```text
primary: rcc-4444/gpt-5.5
backup:  goaichat-openai/qwen3.8-max
```

Remote Console commands over Relay produced:

```text
config.refreshModels(rcc-4444, expectedRevision=3) -> ok
config.refreshModels(goaichat-openai, expectedRevision=4) -> ok
config.apply -> ok
acceptedRevision=5
effectiveRevision=5
```

The persisted Agent config contained `acceptedRevision=5` and
`effectiveRevision=5`. After stopping and starting the Agent again, the Relay
projection read the same `acceptedRevision=5` and `effectiveRevision=5`.

An empty RCC discovery result therefore did not block explicit manual model use and
did not trigger backup selection.

## Real OpenCode provider replay

OpenCode `1.18.23` was started through the managed OpenCode owner with the same
primary and backup targets. Each target was selected explicitly in a real Session
message request:

```text
rcc-4444/gpt-5.5          -> HTTP 200, assistant=teams-rcc-open-code
goaichat-openai/qwen3.8-max -> HTTP 200, assistant=teams-goaichat-open-code
```

No response `model` field was used to rewrite configuration. No automatic failover
was exercised or claimed.

## Source verification

```text
pnpm exec vitest run config/runtime-config.spec.ts config/provider-model-client.spec.ts \
  opencode-adapter/tests/managed-config.spec.ts runtime/managed-opencode-session.spec.ts
4 files passed; 34 tests passed
```

The root source tree was unchanged by the live probes. Credentials were read through
the configured reference only and are not stored in this receipt.

## Remaining boundary

This receipt closes the provider live milestone candidate. The parent issue remains
open until the primary integration owner reconciles this receipt with the remaining
MVP gates (public Relay deployment, real NAT egress, daemon Work replay and Console
offline Work) and records an independent milestone review.
