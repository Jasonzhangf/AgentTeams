# 3c437d7 current-candidate public Relay and Console-offline replay

- Delivery unit: `3c437d7`
- Replay date: `2026-09-12` (America/Los_Angeles)
- Worktree: `playground/3c437d7-mvp-live-20260912`
- Source base: `origin/main@68aacf79d0db36f2c2e3a963c2b51b0bcb00443a`
- Source candidate: `68aacf79d0db36f2c2e3a963c2b51b0bcb00443a` (receipt-only commit follows)
- Candidate tree before receipt: `68aacf79d0db36f2c2e3a963c2b51b0bcb00443a`

## Candidate validation

The clean candidate worktree installed the frozen lockfile and passed:

```text
pnpm install --frozen-lockfile                  PASS
pnpm verify                                    PASS
  71 test files / 431 tests
  typecheck, build, AppSDK guide compile
  AppSDK compile artifact hash:
    sha256:971a15e35aca0c18383ac603056cacd4fd439819ab8bb59b7cc28b746b60298d
  packaged Console and runtime smoke PASS
  appsdk verify: {"ok":true,"project_id":"agentteams","stage":"contract_bound"}
git diff --check                              PASS
```

The deployment archive was built from `generated/modules/teams-source/lib` and
had SHA-256 `2cae8a4ce59efa4c2e773907b6772998ed64d44770c71f9fae22343646d0b5c7`.
The runtime files used by both environments matched the candidate:

```text
runtime/server/relay.js          797a0cbc31bcb30a3a9767f475277d805b723c6480b86bdccd1ad53e341c8ed7
runtime/network/relay-client.js  638fba3d344ba55664c20b427e77017bc41593536f088cf7a33734ec038c471b
runtime/control-protocol/relay-codec.js
                                  5a43e3095b1f825a06783294cefad38aa1a24b29e485d49c6f645ff8ffac2741
runtime/runtime/agent-process.js 8e9a24f78fb28ea2376a3ce70fb6f3dc4d31cdb75da2f45cf33ac3e8a4798521
runtime/runtime/agent-work-client.js
                                  3a15a9e4714622844d7b67b80694efb99513c526b953e95b7a5f321ba62c18f3
```

## Public deployment

The existing Claw service was updated from the old runtime to this exact
artifact. The previous `/opt/agentteams` tree was retained as
`/opt/agentteams.backup-20260912-0145` before the switch. The service was
restarted and verified:

```text
host: VM-0-8-ubuntu / 159.75.134.56
systemctl is-active agentteams-relay.service: active
systemctl is-enabled agentteams-relay.service: enabled
listener: 0.0.0.0:9443, service MainPID 3448136
```

The deployed `relay.js`, `relay-client.js`, and `relay-codec.js` hashes above
matched the candidate, and the deployed source contains the typed
`relay.logout` / `relay.logged-out` control path. No existing ZTerm relay,
Nginx route, DNS record, or firewall rule was reused or changed.

The same archive was staged on coder2new at
`/opt/agentteams.candidate-20260912-0145`. coder2new has no host Node runtime,
so its daemon replay used the preinstalled `node:22-alpine` image with host
networking; the artifact and its `ws` dependency were installed inside the
owned staging tree. No system service was created there.

## Cross-host Agent Work replay

Provider daemon: Claw `claw-test-b`, public Relay generation `1` on the first
run. Consumer daemon: coder2new `claw-test-a` in a one-shot `node:22-alpine`
container with host networking. No Console participated in this replay.

Observed result from the consumer:

```json
{"status":"passed","target":{"providerAgentId":"claw-test-b","generation":1,"capabilityId":"file-search","operation":"search"},"proposal":"accepted","first":{"state":"succeeded"},"duplicate":{"state":"succeeded"},"closed":"closed"}
```

The provider ledger after the run showed:

```json
{"revision":6,
 "works":[{"workId":"mvp-current-cross-host-work-20260912","state":"closed"}],
 "requests":[
   {"requestId":"mvp-current-cross-host-request-20260912","state":"succeeded"},
   {"requestId":"mvp-current-capacity-20260912","state":"failed","error":"RESOURCE_EXHAUSTED"}
 ],
 "allocations":[{"resourceId":"search-slot","amount":1,"state":"released"}]}
```

The duplicate request returned the prior succeeded result; the capacity demand
of three units was rejected explicitly without an additional allocation.

## Restart and generation isolation

The Claw provider was stopped by its recorded PID `3449182` and restarted from
the same config and data directory as PID `3450133`. The coder2new consumer
reported:

```json
{"status":"passed","target":{"providerAgentId":"claw-test-b","generation":2},"staleCode":"STALE_GENERATION","proposal":"accepted","result":{"state":"succeeded","matches":1},"closed":"closed"}
```

This is a real old-generation rejection followed by fresh discovery and Work;
the old generation was not retried as success.

## Console-offline replay

On coder2new, a Console runtime using the same exact artifact and relay
identity `claw-test-a` read the provider projection, shut down completely, and
left the Agent Work path running. While Console was absent, a fresh consumer
daemon completed `file-search` Work and closed it. A second Console runtime
then read the durable projection over the public Relay. The exact replay
returned `projection-status 200`, proposal `accepted`, request `succeeded`,
close `closed`, and the reopened projection contained the new Work in `state:
closed` with `relationPermission: granted` and provider presence `online`.

This proves the Console is an observation/configuration surface for this path;
it was not a required hop for Agent-to-Agent Work.

## Remaining boundary

This receipt does not claim direct transport, NAT-to-NAT traversal, mobile
replay, or live provider catalog/apply/readback. The primary RCC endpoint on
this desktop returned HTTP 200 with an empty model catalog at
`127.0.0.1:4444/v1/models`; provider acceptance remains blocked until the
configured RCC primary exposes a real model and both RCC and the explicit
`goaichat-openai` backup are exercised through OpenCode. No implicit failover
was configured.

## Cleanup pending

Before delivery close, stop the provider PID `3450673` by exact PID, verify no
owned replay container or listener remains, remove the Claw and coder2new
temporary replay trees and the coder2new staging tree, retain the Claw backup
tree for rollback, verify `agentteams-relay.service` remains active/enabled,
and record the resulting cleanup receipt. The owned candidate worktree remains
until review, integration, push, and cleanup are complete.
