# Console-offline Agent Work live receipt

- delivery unit: `9b10ed3-console-offline-live-20260911`
- issue: `9b10ed39738f1d5a3796096325c41692eb3786382a2ef077278b74a905c89433`
- base: `8e743aec4c86dcb8053f6532c6b452e20ccb0407`
- candidate: documentation-only evidence for the exact base runtime; no product source was changed
- owner: Desktop primary integration owner
- replay time: `2026-09-11T00:04:07-07:00` (America/Los_Angeles; evidence UTC `2026-09-11T07:04:07.233Z`)

## Exact live replay

The replay used the built Node runtime entrypoints from this candidate:

```text
server/relay-process.js --config /tmp/agentteams-console-offline-live-9b10ed3-fresh-20260911/relay.json
runtime/agent-process.js --config /tmp/agentteams-console-offline-live-9b10ed3-fresh-20260911/provider.json
runtime/console-process.js --config /tmp/agentteams-console-offline-live-9b10ed3-fresh-20260911/console-1.json
runtime/console-process.js --config /tmp/agentteams-console-offline-live-9b10ed3-fresh-20260911/console-2.json
```

The consumer daemon was started through the built `startAgentProcess` runtime entrypoint in the external Node replay controller so its `consumerWork` owner initiated the Work. This avoids a second login with the same credential and keeps the consumer daemon alive for the whole replay. The controller PID is recorded as the consumer runtime PID.

The local TLS Relay listener was `wss://127.0.0.1:61909`. Recorded PIDs were:

| process | PID |
|---|---:|
| relay | 50495 |
| consumer runtime/controller | 50440 |
| provider | 50555 |
| Console 1 | 50651 |
| Console 2 | 50720 |

Console 1 read a projection showing the provider online and empty `works`/`relations` from the fresh provider data directory. The replay then shut down Console 1; the retained child exit was code `0` with no signal field. While Console 1 was absent, the consumer runtime discovered `file-search/search`, proposed `console-offline-live-work` with `state=accepted`, executed `console offline needle`, received `state=succeeded` with one match, and closed the Work. The provider ledger persisted `state=closed`; the request was `succeeded`; the `search-slot` allocation was `released`.

Console 2 started with a distinct identity and read back:

```text
works[workId=console-offline-live-work].state = closed
relations[workId=console-offline-live-work].relationPermission = granted
agents[provider].presence = online
```

The replay result was `PASS`. The full controller evidence is retained at `docs/evidence/9b10ed3-console-offline-live-20260911/evidence.json`; it contains no credential values.

## Boundary

This receipt proves the real Relay/Agent/Console process lifecycle, Console 1 shutdown, Agent-owned Work continuation, durable provider ledger, and Console 2 HTTP readback on the current runtime. The transport in this receipt is loopback TLS. It does not replace the separate Claw public Relay/NAT and coder2new evidence, and it does not prove direct transport, dual-NAT traversal, mobile access, production installation, or provider catalog/apply/readback.
