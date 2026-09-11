# v1 cross-host live replay receipt

- Result: `BLOCKED`
- Delivery unit: `v1-cross-host-live-20260911`
- Date/time: `2026-09-11T17:53:41Z`
- Worktree: `/Volumes/extension/code/AgentTeams/playground/v1-cross-host-live-20260911`
- Git state: detached `HEAD`
- Required baseline: `origin/main@737266ecc18b06349b7a14064ea8b3f068c71ed4`
- Observed candidate: `737266ecc18b06349b7a14064ea8b3f068c71ed4`
- Candidate tree: `206e051ed306f766d321ae9e3a5d4a5390ea072f`

## Scope

This unit attempted the requested real AgentTeams MVP cross-host replay:
Claw public Relay, coder2new as the second environment, provider/consumer
daemon login, directory discovery, `file-search` capability/resource matching,
Work proposal/request/result/close, provider durable ledger readback, no
Console process, and optional provider restart/generation rejection.

The live replay did not start. This receipt is a blocker receipt, not a PASS.
No directory, Work, ledger, generation, or NAT-egress result is claimed.

## Candidate Build

Required command:

```sh
pnpm build:runtime
```

First attempt from the clean worktree failed because the worktree had no
installed dependencies:

```text
opencode-adapter/src/index.ts(1,41): error TS2307: Cannot find module '@opencode-ai/plugin' or its corresponding type declarations.
opencode-adapter/src/index.ts(2,30): error TS2307: Cannot find module '@opencode-ai/sdk' or its corresponding type declarations.
opencode-adapter/src/index.ts(553,18): error TS7006: Parameter 'eventInput' implicitly has an 'any' type.
opencode-adapter/src/index.ts(556,30): error TS7006: Parameter 'permission' implicitly has an 'any' type.
opencode-adapter/src/index.ts(556,42): error TS7006: Parameter 'output' implicitly has an 'any' type.
ELIFECYCLE Command failed with exit code 1.
```

Install attempts were blocked by this environment. Raw failures were retained:

```text
pnpm install --frozen-lockfile
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY Aborted removal of modules directory due to no TTY

CI=true pnpm install --frozen-lockfile
EPERM EPERM: operation not permitted, unlink '/Volumes/extension/code/AgentTeams/node_modules/ws'

CI=true pnpm install --frozen-lockfile --modules-dir=node_modules --virtual-store-dir=node_modules/.pnpm
ENOTFOUND request to https://registry.npmjs.org/ws/-/ws-8.21.3.tgz failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org
```

To produce the requested artifact without modifying source, this unit used the
existing read-only workspace dependency tree through temporary local symlinks
and reran the same command. Those symlinks were removed after capture.

Final artifact build:

```text
$ pnpm build:runtime
> agentteams@0.1.0 build:runtime
> node -e "require('node:fs').rmSync('generated/runtime-lib', { recursive: true, force: true })" && tsc -p tsconfig.runtime.json
exit code 0
```

Artifact hashes from this run:

```text
076bb40e6992eeac3c19592417eb685caaf40e18e25ea21b11d30580e1ca8560  generated/runtime-lib/runtime/agent-process.js
3a15a9e4714622844d7b67b80694efb99513c526b953e95b7a5f321ba62c18f3  generated/runtime-lib/runtime/agent-work-client.js
```

## Live Entrypoints

- Relay endpoint intended: `wss://claw.codewhisper.cc:9443`
- Claw host intended: public `159.75.134.56`
- coder2new host intended: Tailscale `100.77.236.86`; public
  `154.40.58.131` reserved as comparison only

## Blocker Evidence

Outbound network/DNS is denied before any remote command can execute:

```text
$ nc -vz -w 5 159.75.134.56 22
nc: connectx to 159.75.134.56 port 22 (tcp) failed: Operation not permitted

$ nc -vz -w 5 100.77.236.86 22
nc: connectx to 100.77.236.86 port 22 (tcp) failed: Operation not permitted

$ nc -vz -w 5 claw.codewhisper.cc 9443
nc: getaddrinfo: nodename nor servname provided, or not known

$ dscacheutil -q host -a name claw.codewhisper.cc
bind: Operation not permitted

$ nslookup claw.codewhisper.cc
isc_socket_bind: unexpected error
```

Because local DNS and outbound TCP are denied, this run did not use a
loopback/SSH tunnel and did not substitute local behavior for public Relay
evidence. The requested fallback of starting daemons from remote hosts was also
unavailable because the management SSH entrypoints were blocked locally.

## Required Live Results

```text
Claw Relay read-only service/listener check: NOT RUN, SSH blocked
Provider daemon login/generation: NOT RUN, Claw SSH blocked
Consumer daemon login/generation: NOT RUN, coder2new SSH blocked
Directory discovery: NOT OBSERVED
Capability/resource file-search match: NOT OBSERVED
Work proposal: NOT OBSERVED
Work request/result: NOT OBSERVED
Work close: NOT OBSERVED
Provider durable ledger readback: NOT OBSERVED
Console-offline fact: no Console process was started in this unit; no live
Agent-to-Agent execution occurred
At least one real coder2new outbound NAT path: NOT OBSERVED
Provider restart old-generation rejection: NOT RUN
Fresh-generation success: NOT RUN
```

## Cleanup

- No remote files, secrets, artifacts, configs, data, logs, containers, or
  daemons were created because no remote command executed.
- No production Relay configuration or systemd state was touched.
- The failed frozen install attempted to unlink the shared dependency path
  `/Volumes/extension/code/AgentTeams/node_modules/ws` and returned `EPERM`;
  the main worktree remained clean and the dependency path was rechecked after
  the attempt.
- Local temporary dependency symlinks were removed.
- The partial `/tmp/v1-cross-host-live-node_modules-partial-20260911` path was
  deleted and verified absent.
- Before adding this required receipt, `git status --short` was clean.

## Unblock Condition

Resume on a host/environment with allowed outbound DNS and TCP to:

```text
159.75.134.56:22
100.77.236.86:22
claw.codewhisper.cc:9443
```

The isolated replay worktree must also be able to install the locked
dependencies with `pnpm install --frozen-lockfile`, or have an explicitly
pre-provisioned dependency tree recorded before the replay. The rerun must
record that dependency evidence before building.

The rerun must rebuild/record the current candidate hashes, execute provider on
Claw and consumer on coder2new, capture the live states listed above, and then
clean up only the exact PIDs and temporary resources created by that rerun.
