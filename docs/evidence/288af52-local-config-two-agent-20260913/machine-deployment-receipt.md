# Machine deployment receipt: 288af52

- Machine: desktop (`machineId = desktop`).
- User source: `/Users/fanzhang/.agentteams/config.toml`.
- Internal runtime state: `/Users/fanzhang/.agentteams/internal.toml`.
- Derived endpoint configs: `/Users/fanzhang/.agentteams/.internal/endpoints/*.json`.
- Runtime entrypoint: `generated/runtime-lib/runtime/local-process.js` from main `63bf25b`.
- Credentials: environment references `TEAMS_LOCAL_PROVIDER_AUTH` and `TEAMS_LOCAL_CONSUMER_AUTH`; no credential values are stored in TOML.

## Replay

1. Supervisor started one local Relay and two independent daemons from the persisted config.
2. `internal.toml` recorded provider and consumer `online`, each with PID and generation `1`.
3. Consumer discovered the explicit provider through Relay, negotiated `file-search`, requested one `search-slot`, received the provider result for `local bridge acceptance`, and closed the Work.
4. SIGINT stopped the supervisor and both daemons; `internal.toml` recorded both states as `stopped` and the child PIDs no longer existed.

This is local loopback bridge evidence. It does not claim public Relay, NAT/STUN, mobile, or multi-machine deployment.
