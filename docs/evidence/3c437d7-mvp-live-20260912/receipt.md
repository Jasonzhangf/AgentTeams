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

The coder2new host observation captured during this run was:

```text
eth0             UP             10.0.136.3/24
default via 10.0.136.1 dev eth0
tailscale0       100.77.236.86/32
public IPv4 egress from coder2new: 154.40.58.131
TLS from coder2new to claw.codewhisper.cc:9443: TLSv1.3, CN=claw.codewhisper.cc, Verification=OK
```

The daemon container used host networking on that host. The private `eth0`
address and default gateway, together with the distinct public egress address,
bind this replay to a real NAT outbound path; it is not a Tailscale-only claim.

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
identity `claw-test-a` read the provider projection in Docker container
`cce065b5acbf62a47ea05637d8a4cc8602023b5ea18fbde39a920f2bf30df379`. Its
container state was `running`, PID `1133936`, and the projection became HTTP
200 on attempt 4. It was stopped with `docker stop -t 10` at
`2026-09-12T09:10:49Z`; the container left the running set and
`ss -lntp sport = :61991` returned no listener. An authenticated HTTP probe
failed as expected during that interval.

While the Console container and listener were absent, a fresh consumer daemon
started at `2026-09-12T09:11:05.893Z` and completed at
`2026-09-12T09:11:08.617Z`:

```json
{"status":"passed","targetGeneration":3,"proposal":"accepted","request":"succeeded","closed":"closed","matches":1}
```

A second Console container (`1b00ef7e24cd3628602691e35b635096a7c9b0c782e58a49d0a9a526fbfbcf14`,
started `2026-09-12T09:11:23.511596351Z`) then returned HTTP 200 on attempt 1.
Its projection contained the new Work with `state: closed`, the matching
relation with `relationPermission: granted`, and provider presence `online`.

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

## Cleanup

The owned replay provider PID `3450673` was stopped by exact PID. Both Console
containers were stopped and removed; no owned replay container or port 61991
listener remains. The Claw and coder2new temporary replay trees, scripts, and
coder2new staging tree were removed with targeted path checks. The Claw
rollback tree `/opt/agentteams.backup-20260912-0145` is intentionally retained
for rollback. The formal Claw `agentteams-relay.service` remains active and
enabled on `0.0.0.0:9443`. See the dedicated cleanup receipt in this directory.
