# A11 cross-device receipt — two physical hosts (20261011)

Unit: `acp-a11-crossdevice-20261011`
Worktree: `/Volumes/Intel/playground/agentteams/acp-a11-crossdevice-20261011` (branch `codex/acp-a11-crossdevice-20261011`)
Base: `origin/main@8cb0238` (the D08 integration commit)
Result: **PASS — 19 checks, 0 gaps**. A real ACP prompt/reply crosses from HOST A to HOST B.

## 1. What A11 required

`docs/architecture/verification-map.json` (gate `teams-acp-d08-acceptance`) declares the A11 check as:

> the LAN address is a real connectable non-loopback listener and loopback is never passed off as it

`docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs` proves that half and records the
other half as a boundary, never as a pass:

```
PASS A11 — the LAN address is a real, connectable non-loopback listener — ...
GAP A11 — cross-device receipt — only one physical host is available (LAN 192.168.0.3, tailscale 100.66.1.82);
loopback and same-host non-loopback are never passed off as cross-device, so no cross-device receipt is claimed by this driver
```

This unit replaces that GAP with a real two-host receipt. The single-host LAN half is unchanged and is
not re-claimed here.

## 2. The two devices

| | HOST A | HOST B |
| --- | --- | --- |
| hostname | `Macstudio.local` | `jennys-macbook-air.anoa-buri.ts.net` |
| hardware / OS | Mac Studio, `darwin arm64` | MacBook Air, `darwin arm64`, macOS 15.7.9 |
| Tailscale IPv4 | `100.66.1.82` | `100.93.143.20` |
| LAN IPv4 | `192.168.0.3` | `192.168.1.134` |
| access | local | `ssh -o BatchMode=yes jenny '<cmd>'` (key `~/.ssh/jenny_ed25519`) |
| node | system node | operator-provided `~/.agentteams-node/node-v22.22.2-darwin-arm64/bin` (node v22.22.2, npm 10.9.7) |
| role in this receipt | producer, registry, probe provider, ACP initiator | installed agent daemon + real `opencode` engine |

HOST B has no system node, no `opencode` and no `dsh`. Nothing was installed system-wide and `sudo`
was never used. The `opencode` engine was copied to HOST B as a single arm64 Mach-O binary whose
sha256 equals HOST A's copy (`f7c45939a895e5a9febf141ab16307418bc41da31879aa0b2e65223190ca1c1a`).

## 3. Topology actually exercised

```
HOST A 100.66.1.82                                  HOST B 100.93.143.20
+-------------------------------------+             +---------------------------------------+
| pnpm build:governance -> npm pack   |  scp tarball| npm install --prefix <isolated prefix>  |
| registry start (INSTALLED CLI)      |<------------| agent daemon (INSTALLED CLI --serve)   |
|   wss://100.66.1.82:55565           | registration|   listener wss://100.93.143.20:50991   |
| probe provider http://100.66.1.82   |<------------|   opencode engine (child of the daemon)|
| ACP initiator (installed runtime)   |   ACP WSS   |   own config, identity, data dir, TLS  |
+-------------------------------------+------------>+---------------------------------------+
```

Two independent network crossings exist in this receipt:

1. **HOST B -> HOST A**: HOST B's daemon registers itself with HOST A's discovery registry over
   `wss://100.66.1.82:55565` and publishes its own route `wss://100.93.143.20:50991`.
2. **HOST A -> HOST B**: HOST A authenticates, negotiates, connects and exchanges ACP over
   `wss://jennys-macbook-air.anoa-buri.ts.net:50991`.
3. **HOST B -> HOST A** (inside the ACP exchange): HOST B's `opencode` engine calls the probe provider
   on HOST A (`http://100.66.1.82:54992/v1`) to produce the reply.

## 4. Exact commands

### 4.1 The producer (one command, everything below is inside it)

```sh
cd /Volumes/Intel/playground/agentteams/acp-a11-crossdevice-20261011
node docs/evidence/acp-a11-crossdevice-20261011/cross-device-receipt.mjs
```

Exit code of the recorded run: `0`.

### 4.2 Producer steps, as the script issues them

```sh
# HOST A: the project's own producer and packer
pnpm build:governance                       # -> generated/modules/teams-source/lib + package-receipt.json
npm pack generated/modules/teams-source/lib --pack-destination <tmp>/pack --json

# HOST A -> HOST B: the artifact and its receipt
scp -o BatchMode=yes <tarball> jenny:/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/pack/

# HOST B: isolated install (no system install, no sudo)
ssh -o BatchMode=yes jenny \
  'export PATH="/Users/jenny/.agentteams-node/node-v22.22.2-darwin-arm64/bin:$PATH"; \
   npm install --prefix /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/prefix \
     --no-audit --no-fund --no-package-lock --no-save \
     /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/pack/agentteams-0.1.0.tgz'

# HOST B: its own TLS material, generated ON HOST B so the private key never leaves it
ssh -o BatchMode=yes jenny 'cd /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/tls \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=jennys-macbook-air.anoa-buri.ts.net \
     -addext "subjectAltName=IP:100.93.143.20,DNS:jennys-macbook-air.anoa-buri.ts.net,DNS:localhost,IP:127.0.0.1" \
     -keyout agent-key.pem -out agent-cert.pem'

# HOST A: the discovery registry, from the INSTALLED CLI, on HOST A's Tailscale address
node <hostA-prefix>/node_modules/agentteams/cli/agentteams.mjs registry start --config <tmp>/registry.toml

# HOST B: the agent daemon, from the INSTALLED CLI, on HOST B's own Tailscale address
ssh -o BatchMode=yes jenny 'sh /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/run/start-agent.sh'
#   start-agent.sh ends with:
#   exec node <hostB-prefix>/node_modules/agentteams/cli/agentteams.mjs \
#     --serve opencode --ip 100.93.143.20 --port 50991 \
#     --config /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/run/agent.toml

# HOST A: stop by EXPLICIT PID (both hosts; no pkill/killall/pattern kill anywhere)
node <hostA-prefix>/.../agentteams.mjs registry stop --config <tmp>/registry.toml
ssh -o BatchMode=yes jenny 'kill -TERM 35086'
```

### 4.3 HOST B install output (verbatim)

```
changed 1 package in 318ms
-rwxr-xr-x  1 jenny  staff  45238 Oct 12 08:51
  /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/prefix/node_modules/agentteams/cli/agentteams.mjs
```

## 5. Verbatim output of the successful run

Full log: `raw-run-output.log`.

```
  -- probe provider (HOST A) listening on http://100.66.1.82:54992/v1
  -- HOST A hostname=Macstudio.local tailscale=100.66.1.82
PASS preconditions — two distinct physical hosts — HOST A Macstudio.local (100.66.1.82) vs HOST B jennys-macbook-air.anoa-buri.ts.net (100.93.143.20), macOS 15.7.9 arm64, node v22.22.2, npm 10.9.7
  -- staged this producer's own evidence files for the package identity gate: docs/evidence/acp-a11-crossdevice-20261011/cross-device-receipt.mjs, docs/evidence/acp-a11-crossdevice-20261011/verification.json
  -- running the project producer: pnpm build:governance
PASS producer — pnpm build:governance staged a final package on HOST A — mode=final version=0.1.0 content=b063607e8779e2b2… files=263
  -- producer tail: package artifact final agentteams@0.1.0 b063607e8779e2b2f8862782d75327e844178fe6e6449fa42091fd713fe1c777 generated/modules/teams-source/lib
PASS producer — the staged root packs into one tarball — agentteams-0.1.0.tgz bytes=1516808 sha256=f19211c9bd8123a4…
PASS producer — the tarball installs into an isolated prefix on HOST A and exposes the compiled runtime — cli=/private/var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/a11-xdev-uQd0yJ/prefix/node_modules/agentteams/cli/agentteams.mjs modules=negotiation,routePlan,directRoute,registration
PASS HOST B — the packed tarball installs into an isolated prefix and the installed CLI is byte-identical to HOST A's — prefix=/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/prefix content=b063607e8779e2b2… cliSha256=d97ab857e0a7892f… cli=/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/prefix/node_modules/agentteams/cli/agentteams.mjs
  -- install command: export PATH="/Users/jenny/.agentteams-node/node-v22.22.2-darwin-arm64/bin:$PATH"; npm install --prefix /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/prefix --no-audit --no-fund --no-package-lock --no-save /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/pack/agentteams-0.1.0.tgz
  -- install output: changed 1 package in 318ms
  -- installed CLI: -rwxr-xr-x  1 jenny  staff  45238 Oct 12 08:51 /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/prefix/node_modules/agentteams/cli/agentteams.mjs
PASS TLS — the HOST B listener certificate is generated on HOST B and carries HOST B's own names — X509v3 Subject Alternative Name:   IP Address:100.93.143.20, DNS:jennys-macbook-air.anoa-buri.ts.net, DNS:localhost, IP Address:127.0.0.1
PASS TLS — the HOST B daemon trusts the HOST A registry certificate byte-identically — sha256=b8a571f5caed5d26…
PASS configs — HOST B owns its own config file, identity, data directory and listener — agent=reasoner-b listener=100.93.143.20:50991 data=/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/state discovery=wss://100.66.1.82:55565 sha256=f76afce68ad2bfdf…
  -- probe provider (HOST A) base URL reachable from HOST B: http://100.66.1.82:54992/v1
PASS HOST A — the discovery registry runs from the INSTALLED CLI on HOST A's Tailscale address — started state=running generation=1 config=/var/folders/…/registry.toml daemon=a11-registry pid=20448 url=wss://100.66.1.82:55565
  -- HOST B daemon pid file: 35086
PASS HOST B — the daemon starts from the INSTALLED entrypoint on HOST B's own Tailscale address — serving agent=reasoner-b engine=opencode engineInstance=opencode-reasoner-b-3ecf1cbf-dd88-4226-8b1b-cff11b9a9991 enginePid=35087 daemonPid=35086 listener=100.93.143.20:50991 localChannel=127.0.0.1:51006 lanChannel=wss://100.93.143.20:50991 capabilitiesRevision=2 registration=online dataDirectory=/Users/jenny/.agentteam…
PASS HOST B — the daemon spawned the real opencode engine as its own child — enginePid=35087 model=probe/probe-model modelVerification=session/new configOptions
PASS cross-device — the HOST B daemon registers with the HOST A registry over the network — readiness registration=online; discovery=wss://100.66.1.82:55565
PASS HOST A — HOST A's registry lists HOST B as an online peer with HOST B's own declared Tailscale route — agent=reasoner-b presence=online route=wss://100.93.143.20:50991 revision=2
  -- HOST B hostname jennys-macbook-air.anoa-buri.ts.net resolved on HOST A to 100.93.143.20
PASS HOST A — the peer address is neither loopback nor any HOST A address, and the hostname is a different host — hostname=jennys-macbook-air.anoa-buri.ts.net resolved=100.93.143.20 loopback=false own=false hostA=Macstudio.local
PASS HOST A -> HOST B — authenticate, negotiate and connect over the direct WSS listener — endpoint=wss://jennys-macbook-air.anoa-buri.ts.net:50991 state=agreed observer(master) -> reasoner-b(peer) targetRevision=2
PASS HOST B — the remote opencode engine creates a real ACP Session on HOST B — sessionId=ses_ed2674ee2ffeq3lb5nCGWsmETz cwd=/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/workspace enginePid=35087
PASS HOST A <-> HOST B — a real ACP prompt/reply with a permission callback round trip crosses the two devices — sessionId=ses_ed2674ee2ffeq3lb5nCGWsmETz engine->client session/request_permission(once,always,reject) + client->engine reply -> stopReason=end_turn; session/update delivered; HOST B's engine called the HOST A provider (bash,edit,glob,grep,read,skill,task,todowrite,webfetch,write)
PASS HOST A -> HOST B — a real cancel ends the in-flight remote prompt with the engine's own result — session/cancel -> stopReason=cancelled
PASS HOST B — HOST B's own durable history records the inbound HOST A peer and the negotiated agreement — records=24 negotiated: observer(master) -> reasoner-b(peer) connectionId=f242904d-fd7b-4cd6-84f7-f9a5d195c103 channels=1
  -- HOST B explicit-PID stop: kill -TERM 35086 -> killed=0
  -- HOST B engine pid 35087 exited=true
  -- HOST A registry stop: stopped state=stopped generation=1 … daemon=a11-registry pid=20448
cleanup: removed the HOST A owned root /var/folders/…/a11-xdev-uQd0yJ
cleanup: kept the HOST B install root /Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011 (A11_KEEP_HOST_B=1)

A11 cross-device PASS: 19 checks, 0 gaps
```

## 6. Evidence from both sides

### 6.1 HOST A side (the initiator's view)

* `raw-run-output.log` — every PASS line above.
* The peer address resolved from `jennys-macbook-air.anoa-buri.ts.net` is `100.93.143.20`; the script
  asserts it is not loopback, not any of HOST A's own interface addresses, and that the peer hostname
  differs from `Macstudio.local`.
* The negotiated agreement names both ends: `observer(master) -> reasoner-b(peer)`, target
  capabilities revision `2`.
* HOST A's own registry lists HOST B as `online` with HOST B's self-declared route
  `wss://100.93.143.20:50991`, and that route's revision equals HOST B's readiness
  `capabilitiesRevision=2` — HOST B's own claim, read back on HOST A.
* HOST A received `session/request_permission(once,always,reject)`, replied `once`, received
  `session/update`, and got `stopReason=end_turn`; a second prompt was ended by a real
  `session/cancel` with `stopReason=cancelled`.
* The probe provider on HOST A recorded four calls whose source is HOST B's engine
  (`probeProviderCalls` in `verification.json`), including the tool-capable turn that produced the
  permission callback.

### 6.2 HOST B side (the daemon's own view)

`raw-host-b-daemon.log` — the daemon's own readiness, registration and stop lines:

```
serving agent=reasoner-b engine=opencode engineInstance=opencode-reasoner-b-3ecf1cbf-dd88-4226-8b1b-cff11b9a9991 enginePid=35087 daemonPid=35086 listener=100.93.143.20:50991 localChannel=127.0.0.1:51006 lanChannel=wss://100.93.143.20:50991 capabilitiesRevision=2 registration=online dataDirectory=/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/state config=/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/run/agent.toml model=probe/probe-model modelVerification=session/new configOptions effectiveRevision=1
registration state=online attempts=0 reconnects=0 endpoint=wss://100.66.1.82:55565
registration state=stopped attempts=0 reconnects=0 endpoint=wss://100.66.1.82:55565
stopped agent=reasoner-b enginePid=35087 engine=exited code=null signal=SIGTERM channels=0
```

`raw-host-b-history.json` — HOST B's own durable connection history (`acp-history.json`, 27 records).
The inbound-peer records are:

```
sequence 6  connection.negotiated  agentId=observer  connectionId=f242904d-fd7b-4cd6-84f7-f9a5d195c103
            agreement: observer(master) -> reasoner-b(peer)  targetCapabilitiesRevision=2
sequence 8  channel.opened         agentId=observer  channelId=teams-f242904d-…-1
sequence 26 channel.closed         agentId=observer  channelId=teams-f242904d-…-1
```

HOST B records the peer as `observer` with the role `master` and itself as `reasoner-b` with the role
`peer`. That is HOST B's independent statement that a different host connected in.

## 7. Reproduce

```sh
git worktree add -b codex/acp-a11-crossdevice-20261011 \
  /Volumes/Intel/playground/agentteams/acp-a11-crossdevice-20261011 origin/main
cd /Volumes/Intel/playground/agentteams/acp-a11-crossdevice-20261011
pnpm install --frozen-lockfile
# HOST B must have: node at $A11_HOST_B_NODE_BIN, and an opencode binary at $A11_HOST_B_OPENCODE
# (the producer documents both; it does not install them)
node docs/evidence/acp-a11-crossdevice-20261011/cross-device-receipt.mjs
```

Operator knobs (all have working defaults for this pair of hosts): `A11_SSH_TARGET`,
`A11_HOST_B_TS_IP`, `A11_HOST_B_HOSTNAME`, `A11_HOST_B_HOME`, `A11_HOST_B_NODE_BIN`,
`A11_HOST_B_PREFIX`, `A11_HOST_B_OPENCODE`, `A11_KEEP_HOST_B`.

`A11_KEEP_HOST_B=1` (the default) keeps `/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011`
so a second run can reuse the isolated prefix; the producer still rewrites the tarball and the config
each run and clears its own `state/` and `run/agent.log` first. `A11_KEEP_HOST_B=0` removes the whole
prefix at the end; that removal path was **not exercised** in the recorded run (the run kept the
prefix on purpose), so treat it as a documented option rather than a tested one.

## 8. Cleanup — what was stopped, by explicit PID

| resource | host | PID | how it was stopped | verified |
| --- | --- | --- | --- | --- |
| agent daemon | HOST B | 35086 | `ssh jenny 'kill -TERM 35086'` | `stopped … engine=exited signal=SIGTERM`; `kill -0 35086` -> gone |
| opencode engine child | HOST B | 35087 | reaped by the daemon's own stop | `kill -0 35087` -> gone |
| discovery registry | HOST A | 20448 | installed `registry stop --config` | `stopped state=stopped generation=1` |
| HOST A owned temp root | HOST A | — | `rmSync` after success | `/var/folders/…/a11-xdev-uQd0yJ` removed |
| HOST B install root | HOST B | — | **kept on purpose** (`A11_KEEP_HOST_B=1`) | `/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011` |

No `pkill`, `killall`, `kill $(...)`, `xargs kill` or any pattern kill was used on either host. A
post-run check found no `--serve`, `registry-process` or `opencode` process belonging to this unit on
either host, and no leftover `a11-xdev-*` temp root on HOST A.

Retained on purpose, for a possible second run and for review:

* HOST B: `/Users/jenny/.agentteams-a11/acp-a11-crossdevice-20261011/` (isolated npm prefix, agent
  config, daemon log, durable history, TLS material) — remove with `A11_KEEP_HOST_B=0` or by hand.
* HOST B: `/Users/jenny/.agentteams-a11/engine/bin/opencode` (144 MB, sha256
  `f7c45939…c1a`) — the copied engine binary.

## 9. Honest limits of this receipt

These are the ways this receipt is weaker than it may look. None of them is hidden in the PASS lines.

1. **The model provider is a stub, not a real LLM.** HOST B runs the real `opencode` engine and a real
   ACP session, but the inference endpoint is the same stateless OpenAI-compatible probe provider the
   D08 driver uses. The receipt proves a real ACP prompt/reply across two devices; it does **not**
   prove real model inference on HOST B. The DSH leg with a real provider route was not run
   cross-device: HOST B has no `dsh` install, and copying the 504 MB DSH tree plus a real credential to
   HOST B was out of scope for this unit.
2. **`opencode` on HOST B is a copy of HOST A's binary**, not a HOST B install. It is the same
   bytes (sha256 verified), it runs as an arm64 Mach-O on arm64 macOS 15.7.9, and it runs as a child
   of HOST B's daemon — but it was not installed on HOST B by an installer.
3. **HOST B's node is operator-provided.** The producer asserts the reported version and uses it with
   an explicit PATH; it does not install or verify it beyond that.
4. **The registry runs on HOST A**, not on a third host. That is deliberate (it makes the HOST B
   registration a real cross-device call), but it means both daemons in this receipt have an endpoint
   on one of the two hosts, not on a neutral third machine.
5. **The published `content_sha256` is not commit-stable.** The project's own producer hashes the git
   *index* tree, and the producer stages its own evidence files for the package identity gate, so
   `b063607e…c777` corresponds to `source_state: staged` with this producer's evidence files staged.
   The meaningful, byte-level claims are the ones that are exact: the tarball sha256
   `f19211c9bd8123a477e3b99cce3beb23542ea20de80d44b6caf68bab85b80de9` is identical on both hosts, and
   the installed `cli/agentteams.mjs` sha256 is identical on both hosts
   (`d97ab857e0a7892f2bab791fbc9a377f9fb12b338c256a6af22e541afd859238`).
6. **The `session/cancel` leg is the probe provider's `SLOW-CANCEL` path**, i.e. a deliberately
   hanging stream, not a slow real model. That is the same mechanism the D08 driver uses to prove a
   real cancel.
7. **This receipt is evidence about the installed artifact at `origin/main@8cb0238` plus this
   producer's evidence files.** It says nothing about any other commit, and it is not a review.
8. **Ports and PIDs in this document are from one run.** They are recorded verbatim but they are not
   stable; a re-run picks new free ports and new PIDs.

## 10. Files

| file | what it is |
| --- | --- |
| `cross-device-receipt.mjs` | the self-contained producer (one command, both hosts, explicit-PID cleanup) |
| `verification.json` | machine-readable result: hosts, addresses, artifact hashes, ACP exchange, HOST B side evidence, cleanup |
| `raw-run-output.log` | verbatim stdout of the successful run |
| `raw-host-b-daemon.log` | HOST B's daemon log (readiness, registration, stop) |
| `raw-host-b-history.json` | HOST B's durable `acp-history.json` (inbound peer + agreement) |
| `raw-host-a-registry.log` | the HOST A registry's own start line |
| `notes.md` | this file |
