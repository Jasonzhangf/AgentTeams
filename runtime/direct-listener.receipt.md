# N3-D2 runtime direct listener receipt

Base: `origin/main@f4b2ed2871fc185082b6477f9d6cfa37d9577fc9`, issue `8ea5f7c`.

## First semantic gap

`network/direct-listener.ts` already owns the Agent-owned TLS/WSS listener and typed hello validation. Before this change, `runtime/loadAgentProcessConfig()` rejected any `directListener` field and `runtime/startAgentProcess()` never called `createDirectWssListener()`. The daemon therefore had no runtime lifecycle owner for the listener.

## Runtime change

`runtime/process-config.ts` parses a separate `directListener` control object. It resolves key/certificate paths relative to the config file, resolves the credential only from the named environment variable, validates bind/limits and typed target fields, and rejects a target host/agent identity that differs from the Agent declaration. The persisted target contains only static identity/protocol/capabilities fields; `targetGeneration` is deliberately absent from config. Relay configuration remains a separate required object; no relay candidate is used as a direct listener endpoint.

`runtime/agent-process.ts` creates the listener after relay admission and constructs its typed target with the current `daemon.network.generation`, making the login generation the sole owner of dynamic generation truth on every start. It closes the listener during normal stop and startup failure cleanup. The runtime regression starts the same config twice, observes generation `1 → 2`, completes direct hello on both generations, and confirms an old generation is rejected with `STALE_GENERATION`. TLS material and credentials stay in the runtime control path; no business payload or declaration route is synthesized.

## Boundary / blocker

The runtime can create and close the listener, but it cannot publish the bound endpoint into the Agent Host/server directory without taking ownership of `agent-host/**` or `server/**`. The configured listener port is therefore not advertised by this candidate. N3-D3 must bind route publication to the Agent Host/server owner and carry the listener's actual bound endpoint plus the same typed identity/generation/auth control reference. This candidate does not claim peer discovery, public/NAT reachability, or real device replay.
