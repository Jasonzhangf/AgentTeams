# 3c437d7 coder2new restart and generation replay

- Delivery unit: `3c437d7`
- Related issues: `9b10ed3`, `8ea5f7c`
- Base and candidate source: `origin/main@de4dbaa86bf9b2df3df106a749499dc6f15939ba`
- Candidate source changes: none; this receipt records the exact external replay for the current runtime candidate.
- Replay time: `2026-09-10` (America/Los_Angeles)
- Relay: Claw `wss://claw.codewhisper.cc:9443`
- Provider: Claw `159.75.134.56`, identity `claw-test-b`
- Consumer: coder2new `154.40.58.131` / `ser162766042809`, one-shot `node:22-alpine` Docker, identity `claw-test-a`

## Artifact identity

The same runtime build was used for the provider and consumer:

```text
runtime/agent-process.js
730234b93f9dd0327cb259ead9f7eef208e166a0b98c8195fb53266fa03f61d8

runtime/agent-work-client.js
3a15a9e4714622844d7b67b80694efb99513c526b953e95b7a5f321ba62c18f3
```

Build command: `pnpm build:runtime` (exit `0`).

## Replay

1. Consumer discovered provider `claw-test-b` at generation `31`, capability `file-search` version `1`, operation `search`.
2. Provider was stopped by its exact PID and restarted with the same identity, data directory and relay credentials. The restarted provider published generation `32`.
3. Consumer reused the old target and the relay rejected it with the explicit error:

```json
{"code":"STALE_GENERATION","message":"target generation is stale"}
```

4. Consumer rediscovered provider generation `32`, opened a new Work channel, and completed:

```text
workId=coder2-restart-work-1
proposal=accepted
request=coder2-restart-request-1
request=succeeded
close=closed
```

The request used the real provider `/usr/bin/rg` against the isolated replay root and matched `restart generation needle` in `restart.txt`.

Provider durable ledger readback after the replay:

```text
work coder2-restart-work-1: closed
request coder2-restart-request-1: succeeded
allocation search-slot amount=1: released
```

No Console process participated. The consumer used the existing `startAgentProcess` API and explicit phase file only for orchestration; it did not wait for a stdout registration marker. This is required because daemon registration is an IPC `{kind:"daemon.registered", generation}` message, not stdout.

## Boundary

This proves restart generation isolation and a fresh cross-host/public-relay Agent Work after restart. It does not prove direct transport, dual-NAT traversal, mobile/cellular access, production daemon installation, provider catalog/apply readback, or Console-offline acceptance beyond the absence of a Console in this replay.

## Validation

- `pnpm build:runtime`: PASS.
- Exact replay: PASS as recorded above.
- Integration must rerun the mapped full test, typecheck, AppSDK compile/verify and diff checks against the integration SHA.

## Cleanup

- The replay provider was stopped by exact PID `2832150`; its listener `127.0.0.1:48085` is absent.
- The Claw temporary replay directory and coder2new temporary replay directory were removed.
- No coder2new replay container or `48086` listener remains.
- Formal Claw `agentteams-relay.service` remains `active` and `enabled`.
- The local temporary replay fixtures were removed; only this receipt remains as the delivery change (ignored build/dependency outputs are not delivery changes).
- Integration and remote push remain pending; cleanup of this delivery unit is complete only for replay resources, not Git delivery.
