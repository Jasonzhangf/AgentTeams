# Agent process entry

`startAgentProcess` composes one capability Agent with its own durable Work
ledger, CLI executor and Relay connection. Passive Agents need no model
provider. An optional `openCode` section enables the same daemon to own a
managed OpenCode child and expose provider/model configuration through the
Console control channel; Session execution remains a separate capability.

Build with `pnpm build:runtime`; the executable entry is
`node generated/runtime-lib/runtime/agent-process.js --config /absolute/agent.json`.
The current output needs the workspace dependencies, including `ws`; it is not
a standalone dependency-free distribution. Installation-copy replay is a
separate requirement from compilation and source tests.

Configuration is strict JSON version 1. Paths resolve relative to the config
file. Credentials come only from the named environment variable, never from
the JSON configuration or business payload. For example:

```json
{
  "version": 1,
  "identity": {
    "hostId": "browser-host",
    "machineId": "machine-1",
    "agentId": "browser-agent",
    "accountId": "account-1",
    "agentKind": "custom",
    "label": "Browser Agent"
  },
  "scopeId": "project-1",
  "dataDirectory": "./agent-data",
  "leasePort": 47821,
  "presenceIntervalMs": 5000,
  "policy": { "revision": 1, "allowedConsumers": ["consumer-agent"] },
  "cli": {
    "camoExecutable": "/opt/homebrew/bin/camo",
    "searchExecutable": "/opt/homebrew/bin/rg",
    "searchRoot": "./read-only-files",
    "profilePrefix": "teams-browser-agent"
  },
  "relay": {
    "endpoint": "wss://relay.example.com:443",
    "credentialEnv": "TEAMS_RELAY_CREDENTIAL",
    "connectTimeoutMs": 5000,
    "admissionTimeoutMs": 5000,
    "requestTimeoutMs": 30000,
    "maxMessageBytes": 1048576,
    "maxBufferedBytes": 2097152,
    "maxPendingFrames": 64,
    "maxPendingRequests": 32,
    "maxDataConnections": 16
  }
}
```

`caFile` may be added inside `relay` for a configured private CA. The Relay
must admit the configured identity/account/scope; provider Work admission
independently requires membership in `policy.allowedConsumers`.

Optional `policy.allowedManagers` lists Agent identities permitted to use the
Console management protocol in this account/scope. Omission means no managers;
Work consumption does not grant management authority. The passive process
projects its actual CLI capabilities and explicitly rejects Session/model
configuration commands it cannot execute. A malformed or expired data
connection closes independently, with a diagnostic error code; it does not
remove the Agent's registration or prove an operation completed.

The loopback `leasePort` must be free and unique on the local machine. The
kernel releases it when the process exits. `identity.json` binds the data
directory to the stable identity, scope and lease port; changing these fields
is rejected. Do not delete that record to bypass an ownership conflict.

The process initially registers without capabilities, loads its Work ledger,
then publishes revision 2 and confirms directory readback before reporting
registration through its optional parent IPC channel. This ordering confirms
composition readiness, not successful execution of every external tool.

SIGTERM and SIGINT close network admission and request local Work cleanup.
Resource release still requires actual completion and destruction. A startup
with held allocations or unconfirmed executions fails with `RESULT_UNKNOWN`;
trusted reconciliation of active Work after a crash is not implemented yet.
Do not clear the ledger, relabel requests successful or retry unknown side
effects to force startup. Completed, closed Work remains queryable after a
normal restart; idle crash restart is separately tested.

`runtime/agent-process.spec.ts` exercises a real Node child over local TLS
Relay: fixed-root search, duplicate process rejection, completed-result
readback, graceful restart and idle SIGKILL restart. It also starts a managed
inference child with a stub OpenCode executable, applies a durable provider
binding through the remote Console ingress, and reads accepted/effective
revision `3` back. It reads management projections through Relay, rejects
unsupported commands and verifies malformed data isolation and management
denial independently of Work admission. It does not prove public
NAT transport, real phone access, active browser recovery or installed Agent
deployment.

For an inference Agent, add `openCode` with absolute executable and directory
paths, a durable `configFile`, and a free local `port` plus positive startup and
stop deadlines. Provider credential references are resolved from the daemon's
environment at apply time; values never enter the JSON config, Console
projection, or Session payload. Configuration changes remain CAS-protected:
accepted state is persisted first, and `effectiveRevision` advances only after
the child reports authenticated, matching `/config` readback. A failed apply is
explicit and does not select the configured backup automatically.
