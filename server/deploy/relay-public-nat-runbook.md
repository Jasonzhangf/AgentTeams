# N1/V1 public relay and NAT daemon deployment runbook

Delivery unit: `3c437d7` (N1/V1 deployment readiness).

This document is the retained runbook and receipt template for running the
relay-first MVP path against a public AgentTeams Relay on Claw and a second
environment behind NAT, such as the existing `coder2new` host used in
`docs/evidence/3c437d7-coder2-m2m-20260910/receipt.md`. It does not claim that a
live deployment has been run by this document's existence. A live claim requires
the actual external commands, process/listener evidence, and cleanup evidence
below.

## Code status

The Relay implementation and deployment assets are sufficient for a real public
Relay deployment. This unit does not require production code changes:

- `server/relay-process.ts` is the compiled Node entrypoint.
- `server/deploy/agentteams-relay.service` is the systemd service unit.
- `server/deploy/install-relay.sh` installs the packaged artifact.
- `server/deploy/relay.example.json` and `server/deploy/relay.env.example` define
  the strict credential-reference config shape.
- `runtime/agent-process.md` documents the daemon entrypoint used on Claw and the
  second environment.

The smallest missing piece for a repeatable real run is a precise retained
runbook/receipt template. This file is that artifact.

## Ownership and scope

Only `server/**` and deployment evidence/docs are owned by this unit. Do not
modify config, runtime, agent, UI, maps, or other worktrees. If any step below
would touch an existing service, credential store, DNS record, or production
entrypoint, it requires explicit authorization before execution.

## External prerequisites

Before starting, confirm the following are available:

- Authorized shell/SSH access to Claw (`159.75.134.56` in the prior receipts).
- Authorized shell/SSH access to a second environment, e.g. coder2new
  (`154.40.58.131`, hostname `ser162766042809`), with real outbound NAT access
  to the Relay hostname and port.
- DNS and TLS for the public Relay endpoint, e.g.
  `wss://claw.codewhisper.cc:9443`, with a certificate that matches the hostname
  from both Claw and the second environment.
- Relay and Agent credential values are available outside source control. The
  config only stores environment variable names; receipts must record env names,
  never credential values.
- Node 22 and pnpm are available on both hosts, or the second host can run a
  `node:22-alpine` container with host networking.
- The provider host has `/usr/bin/rg` or another fixed search executable plus an
  isolated read-only search root.

## Build and verify the candidate

Build and verify the exact candidate before copying an artifact:

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm build:runtime
pnpm build:governance
git diff --check
```

The packaged artifact root is `generated/modules/teams-source/lib` after
`pnpm build:governance`. Record these identities in the receipt:

```text
candidate commit
candidate tree
  runtime/runtime/agent-process.js sha256
  runtime/runtime/agent-work-client.js sha256
relay-process.js sha256 (if the relay is installed from the same artifact)
```

## Install or verify the public Relay on Claw

For a new relay install:

1. Create the service user, config directory, TLS directory, and search root as
   authorized.
2. Generate or place `relay-key.pem` and `relay-cert.pem` under
   `/etc/agentteams/tls/`.
3. Write `/etc/agentteams/relay.json` modeled on
   `server/deploy/relay.example.json`. Use `listen.host: "0.0.0.0"` and the
   public port, e.g. `9443`. Use one `credentialEnv` per Agent identity. Do not
   put credential values in this file.
4. Write `/etc/agentteams/relay.env` modeled on
   `server/deploy/relay.env.example` and protect it with `chmod 600`. Each value
   is the exact HTTP `Authorization` header, e.g. `Bearer <secret>`.
5. Install the packaged artifact:

```sh
./server/deploy/install-relay.sh <artifact-root> /opt/agentteams
```

The installer refuses to overwrite an existing `/opt/agentteams`. For an already
running relay, verify the existing installed artifact and service rather than
re-installing.

6. Install and start the systemd unit:

```sh
install -m 0644 server/deploy/agentteams-relay.service /etc/systemd/system/agentteams-relay.service
systemctl daemon-reload
systemctl enable --now agentteams-relay.service
```

7. Confirm the service and listener:

```sh
systemctl is-active agentteams-relay.service
systemctl is-enabled agentteams-relay.service
ss -lntp 'sport = :9443'
journalctl -u agentteams-relay.service -n 100 --no-pager
```

TLS reachability is not sufficient. The real admission proof is two Agent
daemons logging in through `wss://claw.codewhisper.cc:9443`, querying the
directory, and completing Work.

## Start provider and consumer daemons

Use the same artifact and source commit on both hosts. The provider can run on
Claw; the consumer must run on the second environment behind NAT for the
relay-first NAT-outbound evidence.

The Agent process entrypoint is:

```sh
node /opt/agentteams/runtime/runtime/agent-process.js --config /srv/agentteams/<agent>.json
```

For local compiled source use `generated/runtime-lib/runtime/agent-process.js`
instead. The config is strict JSON version 1; see `runtime/agent-process.md`.
Credential values are read from the daemon's environment by `credentialEnv` and
never appear in the JSON config, declaration, logs, or receipt.

Provider config fields for the replay:

```json
{
  "version": 1,
  "identity": {
    "hostId": "<provider-host>",
    "machineId": "<provider-machine>",
    "agentId": "claw-test-b",
    "accountId": "<account>",
    "agentKind": "custom",
    "label": "Claw provider"
  },
  "scopeId": "<scope>",
  "dataDirectory": "./provider-data",
  "leasePort": <free-port>,
  "presenceIntervalMs": 3000,
  "policy": {
    "revision": 1,
    "allowedConsumers": ["claw-test-a"]
  },
  "cli": {
    "camoExecutable": "/missing/camo",
    "searchExecutable": "/usr/bin/rg",
    "searchRoot": "./read-only-files",
    "profilePrefix": "teams-replay"
  },
  "relay": {
    "endpoint": "wss://claw.codewhisper.cc:9443",
    "credentialEnv": "TEAMS_RELAY_AGENT_B",
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

Consumer config fields are the same shape with `agentId: "claw-test-a"`,
`credentialEnv: "TEAMS_RELAY_AGENT_A"`, its own data directory and lease port,
and `allowedConsumers: []` unless it also serves as a provider.

The daemon reports registration through IPC `{kind:"daemon.registered",
generation}` when spawned with `stdio: ["ignore", "pipe", "pipe", "ipc"]`.
Do not wait for a stdout marker. Confirm the directory contains both peers before
starting Work.

## Replay and evidence

1. Create an isolated read-only file on Claw containing a unique needle.
2. From the consumer host, discover provider `claw-test-b` with capability
   `file-search`, version `1`, operation `search`.
3. Propose Work, request the fixed-root search, then close Work.
4. If required for restart coverage, stop the provider by exact PID, restart the
   same config, verify an old consumer-held target is rejected with
   `STALE_GENERATION`, rediscover the fresh generation, and complete a second
   Work.
5. Read the provider ledger on Claw and record Work/request states and released
   allocations.
6. Record all commands, process IDs, generations, and output without credential
   values.

## Receipt template

```markdown
# N1/V1 public relay and NAT daemon replay receipt

- Delivery unit: `3c437d7`
- Date/time: <UTC>
- Worktree/branch: <worktree>, <branch>
- Base: <origin/main sha>
- Candidate: <sha>; tree: <tree sha>
- Artifact hashes:
  - runtime/agent-process.js = <sha256>
  - runtime/agent-work-client.js = <sha256>
- Relay endpoint: `wss://<relay-host>:<port>`
- Relay host: Claw public IP `<ip>`, hostname `<hostname>`
- Second environment: coder2new public egress IP `<ip>`, hostname `<hostname>`,
  behind real NAT outbound `<yes/no>`, not Tailscale-only `<yes/no>`
- Relay service: `systemctl is-active/is-enabled` -> `<active>/<enabled>`
- Relay listener: `ss -lntp 'sport = :<port>'` -> `<listener owner pid>`
- Provider identity: `<agentId>`, generation `<gen>`, host `<host>`
- Consumer identity: `<agentId>`, generation `<gen>`, host `<host>`
- Capability: `<capabilityId>/<version>/<operation>`
- Work observed:
  - workId=<id>
  - proposal=<accepted|rejected>
  - request=<succeeded|failed|unknown>
  - close=<closed>
- Provider ledger readback:
  - work=<closed>
  - request=<succeeded>
  - allocation=<released>
- Restart evidence (if applicable):
  - old generation rejected with `<error code>`
  - fresh provider generation `<gen>`
  - second Work `<workId>` completed `<state>`
- Validation commands/results:
  - `pnpm verify` -> PASS (<tests>)
  - `pnpm build:runtime` -> PASS
  - `pnpm build:governance` -> PASS
  - `appsdk compile` -> PASS
  - `appsdk verify` -> PASS (`stage=contract_bound`)
  - `git diff --check` -> PASS
- Cleanup:
  - exact PID stops: <pids>
  - temp directories removed: <paths>
  - coder2new container/process removed: <id/pid>
  - no owned replay listeners remaining: <check output>
- Blocker/credentials:
  - env names used: <credentialEnv names only>
  - external entrypoints used: <relay endpoint>, <provider host>, <consumer host>
  - live deployment claimed: <no unless real replay evidence above>
```

## Cleanup

After the replay, stop only the exact PIDs owned by this delivery, remove owned
temporary directories and containers, and verify that the formal
`agentteams-relay.service` remains as it was before the run. Never use broad
process kill commands. Never delete a data directory or ledger without explicit
authorization.

## Known external blockers

- No authorized credentials were added by this document. A real run needs the
  actual `Authorization` values and the exact `credentialEnv` names in the Claw
  relay service and second-environment daemon config.
- DNS/TLS for the public Relay must be valid from both Claw and the second
  environment; prior receipts used `wss://claw.codewhisper.cc:9443`.
- NAT evidence must come from a real second environment, not Tailscale-only or
  split-DNS routing.
- Do not modify the existing production relay service without explicit
  authorization; a candidate replay can run with temporary provider/consumer
  daemons and clean them up afterward.
