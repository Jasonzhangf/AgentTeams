# Console-offline current-candidate blocker receipt f31e28c

- delivery unit: `9b10ed3-console-offline-live-20260911`
- issue: `9b10ed3` (`9b10ed39738f1d5a3796096325c41692eb3786382a2ef077278b74a905c89433`)
- candidate base/current SHA: `f31e28c71c2e403503bd34edc3a20c2c88d93fa5`
- verified worktree HEAD: `f31e28c71c2e403503bd34edc3a20c2c88d93fa5`
- verified `origin/main`: `f31e28c71c2e403503bd34edc3a20c2c88d93fa5`
- worktree: `/Volumes/extension/code/AgentTeams/playground/9b10ed3-console-offline-rebaseline-20260911`
- branch: `codex/9b10ed3-console-offline-rebaseline-20260911`
- timestamp: `2026-09-11T19:50:50Z` (America/Los_Angeles `2026-09-11T12:50:50-0700`)
- result: `BLOCKED`

## Required gate

The Console-offline MVP gate for issue `9b10ed3` requires all of the following
against this candidate and retained from the candidate SHA above:

- real public Relay login, discovery, and authenticated transport through the
  current candidate runtime;
- at least one real NAT egress participating in the Agent-to-Agent Work path;
- Console fully absent while Agent Work starts and completes;
- Agent Work continuation and durable ledger/state projection readback;
- a reopen observation surface projection/ledger readback that sees the
  completed Work state without the issuing Console being present.

This receipt is a blocker receipt only. It does not claim live PASS for the
current candidate, and it does not use the older loopback receipt as current
candidate acceptance.

## Environment probe

All commands ran from the task worktree above. The first observed failure is
outbound DNS for `claw.codewhisper.cc`; direct TCP and SSH probes to the known
prior replay hosts fail with `Operation not permitted`.

Probe commands and raw failing output:

```text
nc -vz -w 5 claw.codewhisper.cc 9443
nc: getaddrinfo: nodename nor servname provided, or not known
RELAY_NC_EXIT:1
```

```text
curl -LksS --max-time 8 https://claw.codewhisper.cc:9443/ -o /dev/null -w 'HTTP:%{http_code}\n'
curl: (6) Could not resolve host: claw.codewhisper.cc
HTTP:000
RELAY_CURL_EXIT:6
```

```text
nc -vz -w 5 159.75.134.56 9443
nc: connectx to 159.75.134.56 port 9443 (tcp) failed: Operation not permitted
RELAY_IP_TCP_EXIT:1
```

```text
nc -vz -w 5 159.75.134.56 22
nc: connectx to 159.75.134.56 port 22 (tcp) failed: Operation not permitted
CLAW_SSH_TCP_EXIT:1
```

```text
nc -vz -w 5 154.40.58.131 22
nc: connectx to 154.40.58.131 port 22 (tcp) failed: Operation not permitted
CODER_SSH_TCP_EXIT:1
```

```text
ssh -o BatchMode=yes -o ConnectTimeout=5 <replay-user>@159.75.134.56 'hostname'
ssh: connect to host 159.75.134.56 port 22: Operation not permitted
CLAW_SSH_EXIT:255
```

```text
ssh -o BatchMode=yes -o ConnectTimeout=5 <replay-user>@154.40.58.131 'hostname'
ssh: connect to host 154.40.58.131 port 22: Operation not permitted
CODER_SSH_EXIT:255
```

No live relay login, directory readback, Work status, allocation readback, or
Console readback was obtained because the required public Relay and prior replay
hosts were unreachable from this environment.

## Historical boundary

The existing loopback-only Console-offline receipt in this directory is based on
`8e743aec4c86dcb8053f6532c6b452e20ccb0407` and local TLS. It is retained as
historical boundary evidence only and cannot be reused as a current-candidate
PASS for the gate above. The prior blocker receipt for `3c7dfb942` is also
historical; it does not replace this f31e28c-bound blocker receipt.

## Test and validation

No live replay was run after the blocker because the public Relay/real NAT
egress path was not reachable. Tracked-worktree `git diff --check` passed. The
new receipt could not be staged due the sandbox Git metadata failure below, so
whitespace on the untracked receipt was additionally checked with
`git diff --no-index --check /dev/null
docs/evidence/9b10ed3-console-offline-live-20260911/current-candidate-blocker-f31e28c.md`;
no whitespace errors were printed.

`pnpm verify` was attempted and stopped at the first `pnpm test` step because
the worktree had no installed dependencies:

```text
pnpm verify
> agentteams@0.1.0 verify /Volumes/extension/code/AgentTeams/playground/9b10ed3-console-offline-rebaseline-20260911
> pnpm test && pnpm typecheck && appsdk guide compile && appsdk compile && pnpm smoke && appsdk verify
>
> agentteams@0.1.0 test /Volumes/extension/code/AgentTeams/playground/9b10ed3-console-offline-rebaseline-20260911
> pnpm --dir opencode-adapter build && node scripts/regression.mjs
>
> @deepseek-ai/teams-opencode-adapter@0.1.0 build /Volumes/extension/code/AgentTeams/playground/9b10ed3-console-offline-rebaseline-20260911/opencode-adapter
> tsdown src/index.ts --out-dir lib --format esm --platform node --target es2022 --dts --clean

sh: tsdown: command not found
ELIFECYCLE Command failed.
WARN Local package.json exists, but node_modules missing, did you mean to install?
```

The failed verify command is retained as environment evidence, not as a live
acceptance result.

### Commit status

This receipt is currently present in the worktree as an untracked file.
`git add` and `git commit` were attempted and blocked by the current sandbox
before any repository metadata write:

```text
git add docs/evidence/9b10ed3-console-offline-live-20260911/current-candidate-blocker-f31e28c.md
fatal: Unable to create '/Volumes/extension/code/AgentTeams/.git/worktrees/9b10ed3-console-offline-rebaseline-20260911/index.lock': Operation not permitted
GIT_ADD_EXIT:128
```

```text
git commit -m 'docs(9b10ed3): record current candidate blocker f31e28c'
fatal: Unable to create '/Volumes/extension/code/AgentTeams/.git/worktrees/9b10ed3-console-offline-rebaseline-20260911/index.lock': Operation not permitted
GIT_COMMIT_EXIT:128
```

A temporary-index add workaround was also blocked before object insertion with
`unable to create temporary file: Operation not permitted` and
`failed to insert into database`; repository object metadata is not writable
from this sandbox.

No push or remote operation was performed.

## Cleanup obligations

- No relay, daemon, Console, consumer, provider, or temporary replay process
  was started by this delivery unit.
- No temporary replay directories or credential material were created or
  retained.
- The only intended write path is
  `docs/evidence/9b10ed3-console-offline-live-20260911/current-candidate-blocker-f31e28c.md`.
- Existing files in the evidence directory, source, maps, package files, and
  other worktrees are left untouched.
- This unit must not push or merge; after the required commit is recorded, the
  worktree and branch remain owned by this delivery until released.

## Unblock conditions

Responsible party for unblocking: the environment/network owner that can allow
outbound DNS, TCP/TLS, and SSH access to the public Relay and prior replay
hosts, or a provider of an equivalent real public relay/NAT replay environment.
The documentation/evidence worker cannot unblock the live gate locally.

To unblock, provide an environment that can reach the real Claw AgentTeams
Relay and the prior replay hosts, or equivalent public relay/NAT hosts, with
the same replay artifact and identity setup used by prior project live replays:

- outbound DNS/TCP/TLS access to `wss://claw.codewhisper.cc:9443` (or an
  equivalent public relay endpoint); and
- at least one real NAT egress available for a provider/consumer pair, plus
  Console/controller identities and provider/consumer data setup equivalent to
  prior replay evidence; or
- SSH access to the prior replay hosts used by `3c437d7-coder2-m2m-20260910`
  and `3c437d7-coder2-restart-20260910`, with the same relay and isolated replay
  artifacts.

Once unblocked, the gate must be re-run from `f31e28c71c2e403503bd34edc3a20c2c88d93fa5`
and recorded in a current candidate PASS receipt, not by extending this blocker.
