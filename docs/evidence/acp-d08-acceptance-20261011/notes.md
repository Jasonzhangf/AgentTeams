# D08 final-acceptance run notes — 2026-10-11

Owner: D08 acceptance driver.
Worktree `/Volumes/Intel/playground/agentteams/acp-d08-acceptance-20261011`,
branch `codex/acp-d08-acceptance-20261011`, base commit `d37d3b9` (`origin/main`).
Nothing in this directory is committed by this worker.

| file | purpose |
| --- | --- |
| `black-box-acceptance.mjs` | the one real black-box driver |
| `notes.md` | this record: invocation, results, gaps, findings, boundaries |
| `verification.json` | machine-readable check / gap / finding / boundary summary |

## 1. Exact invocation

```bash
node docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs
```

Canonical run (final artifact state, all three files in this directory present), exit
code `0`, wall clock 131 s, empty stderr:

```
D08 acceptance PASS: 43 checks (gaps: 4, findings: 1) in 131s
cleanup: removed owned root /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/d08-acc-Xvr5qP
```

Three further full runs reached the same `43 checks / 4 gaps / 1 finding` result
(`136s`, `134s`, `133s`). Ports, pids and sessions differ per run because every run
creates its own temp root; the check, gap and finding counts are deterministic. The pids
quoted in this file are the canonical run's.

Two recorded values are *not* stable identities, and are quoted with that caveat:
`content_sha256` changes whenever the staged candidate tree changes (the driver's own
evidence files are part of that tree), and the tarball is 1 516 505–1 516 507 bytes because
its tar header carries the build time. The stable facts are `mode=final`,
`version=0.1.0` and `files=263`.

The driver prints one `PASS <name> — <detail>` per check, `GAP <name> — <reason>` for a
coverage boundary that the candidate cannot prove, and `FINDING <name> — <detail>` for an
observed product defect that falsifies no check. Exit `0` means every check passed; a
failed assertion prints `D08 acceptance FAIL [<step>]: <reason>` on stderr, dumps the
daemon logs, keeps the owned temp root, and exits `1`.

It flushes stdout before `process.exit(process.exitCode ?? 0)`.

Environment overrides (defaults are this host's real values; no credential value is ever
printed or written):

| variable | default |
| --- | --- |
| `OPENCODE_EXECUTABLE` | `/Users/fanzhang/.opencode/bin/opencode` |
| `DSH_EXECUTABLE` | `/opt/homebrew/bin/dsh` |
| `D08_PROVIDER_BASE_URL` | `https://api.xyxl1225.online/8318/v1` |
| `D08_PROVIDER_MODEL` | `wb-deepseek-v4.1-flash` |
| `D08_DSH_CREDENTIAL_REF` | `DEEPSEEK_FLASH_API_KEY` |
| `DSH_CREDENTIALS_FILE` | `~/.dsh/.credentials.yaml` |
| `D08_STEP_DEADLINE_MS` | `120000` |

Prerequisites: `pnpm`, `npm`, `openssl`, `ps`, one non-internal IPv4 interface, and both
engine executables. The driver creates its own temp root, starts every daemon from it,
stops every process by explicit pid in `finally`, and removes the root on PASS.

### Precondition the driver enforces and repairs

`pnpm build:governance` (`pnpm build && node scripts/package-artifact.mjs --mode final`)
refuses a candidate whose tree contains untracked or unstaged product paths
(`scripts/receipt-identity.mjs`). This driver is itself a new untracked file, so before
running the producer it stages **only its own evidence directory**:

```
git ls-files --others --exclude-standard  +  git diff --name-only
  -> refuse any path outside docs/evidence/acp-d08-acceptance-20261011/
  -> git add -- <own paths>
```

It never commits, resets, checks out, stashes, rewrites history, or passes `--no-verify`,
and it never stages another owner's path. Run log line:
`-- staged the driver's own evidence files for the package identity gate: docs/evidence/acp-d08-acceptance-20261011/black-box-acceptance.mjs`.

## 2. Installed-artifact chain (why this is installed evidence, not source evidence)

1. `pnpm build:governance` runs the real project producer and stages a **final** package:
   `mode=final version=0.1.0 content=d22b43791c31d7e1… files=263`. The `files=263` and
   `mode=final` values are stable across every recorded run; the `content_sha256` is a
   function of the staged candidate tree, so it changes when the driver's own evidence
   files change.
2. `npm pack <packRoot> --pack-destination <ownedRoot>` produces
   `agentteams-0.1.0.tgz` (1 516 505–1 516 507 bytes across runs, because the tar header
   carries the build time) — the project's own packing entry, not a hand-built tarball.
3. `npm install --prefix <ownedRoot>/prefix <tarball>` performs the project's isolated
   install. The CLI used by every later step is
   `<ownedRoot>/prefix/node_modules/agentteams/cli/agentteams.mjs`, and the driver asserts
   that its `realpath` is inside the installed prefix and is **not** the worktree source
   entry.
4. The Teams network modules are imported from the installed compiled runtime
   (`<installed>/generated/runtime-lib/network/{negotiation,routePlan,directRoute,registration}.js`)
   through `pathToFileURL`, so the driver's client side is the shipped artifact too.
5. Every daemon is started through the installed CLI: `registry start`, `control start`,
   and `--serve opencode` / `--serve dsh` for the two Agent Hosts. No worktree debug
   binary is used as runtime evidence.

The two engine executables are the host's real engines: `opencode 1.18.23`
(`/Users/fanzhang/.opencode/bin/opencode acp --pure`, a real child process of the
installed daemon) and `dsh 0.2.0-rc.2`. Inference is served by a driver-owned local
OpenAI-compatible stub provider for OpenCode, and by the **real** configured provider
route for DSH (see A02).

## 3. Topology the driver builds

| role | config | identity | address |
| --- | --- | --- | --- |
| Agent Host A | `agent-a.toml` | `reasoner-a` | `192.168.0.3:<port>` (opencode) |
| Agent Host B | `agent-b.toml` | `reasoner-dsh` | `192.168.0.3:<port>` (dsh) |
| Control Host | `control.toml` | `control-a` | `127.0.0.1:<port>` |
| Registry | `registry.toml` | `lan-registry` | `127.0.0.1:<port>` (TLS) |
| Observer | `observer.toml` | `observer` | `127.0.0.1:<port>` (ACP client, not a Console) |
| Lease probe | `lease-probe.toml` | `lease-probe` | `127.0.0.1:<port>` |
| Offline probe | `offline-probe.toml` | `offline-probe` | `127.0.0.1:<port>` |

All four configs use the frozen single-daemon v4 schema. Agent Hosts bind the real LAN
address `192.168.0.3`, so A04/A05/A10 traffic crosses a real non-loopback interface; the
driver never substitutes loopback for a LAN claim.

## 4. Results by acceptance item

| item | status | checks | evidence |
| --- | --- | --- | --- |
| A01 one config → one daemon; independent identity/storage/IP/port; CLI readback | PASS | 6 | each config produced exactly one daemon process and one engine child; four distinct identities, four distinct data directories, four distinct endpoints; `registry status` and `control status` read back `state=running` with real pids/generations; a control config passed to `--serve` and a v3 config are both refused with `UNSUPPORTED_CONFIGURATION` |
| A02 OpenCode and DSH each complete a real prompt/process/reply | PASS | 3 | OpenCode: real `opencode acp --pure` child of the installed daemon, `session/new` → `session/prompt` → real `session/request_permission` (once/always/reject) → reply → `stopReason=end_turn`, provider served the turn. DSH: real `dsh` child, `model=["teams-workbuddy","wb-deepseek-v4.1-flash"]`, `stopReason=end_turn` through the real configured provider route |
| A03 config names the server; automatic registration, heartbeat, lease offline, restart and reconnect | PASS | 5 | registration is automatic against `wss://127.0.0.1:<port>` with no manual step; `lastSeenAt` advanced over a 15 s heartbeat window; the server-owned lease (`peerTtlMs=90_000`) published `lease-probe` as `presence=offline` while its registration socket stayed online; explicit-pid stop → entry retained `offline` → restart → `online` with a new pid; registry stop → the daemon reports a degraded registration state and keeps naming its configured endpoint → registry restart → `online` again |
| A04 discover, authenticate, negotiate, connect; both sides know the role; role grants no extra authority | PASS | 5 | a wrong credential is refused at the transport (`network: WSS connection failed`) with no `connection.negotiated` record; negotiation reaches `state=agreed` with `policyRevisions=3/1` over the real LAN listener; both sides report the same `master->peer` agreement; the same daemon serves `master/peer` on one leg and `peer/master` on the other; the master leg and the peer leg are both refused `session/load` with `UNSUPPORTED_METHOD` |
| A05 bidirectional ACP response/update/callback; cancel and unknown outcome | PASS | 7 | engine→client `session/request_permission` with real options plus client→engine reply released the tool and completed the prompt, with a real `session/update` delivered over LAN; `session/cancel` ended an in-flight prompt with `stopReason=cancelled`; closing a channel mid-prompt left a durable `result.unknown outcome=unknown` and no replay after reconnect; an outstanding callback from the pre-restart engine instance is refused with `CALLBACK_UNAVAILABLE` after the restart; an established LAN channel completed real prompts while the registry was stopped, after every WebUI client connection closed, and while no control daemon was running |
| A06 blacklist refuses before a side effect; an unexecutable native-tool policy refuses configuration | PASS | 2 | a blacklisted `method:session/set_config_option` was refused with `CAPABILITY_DENIED`, appended no `request.dispatched` record, and left the provider call count unchanged; blacklisting a native tool is refused at configuration time with `UNSUPPORTED_POLICY` for opencode-unknown, foreign-engine and DSH cases |
| A07 WebUI discovery, networking, targeted interaction, history; real-event-driven animation | PARTIAL | 5 | PASS: the authenticated console serves `/`, `/console-entry.js`, `/ui/browser.js`; the barrel-reachable module graph carries 8 frozen DOM markers; `/api/v1/projection`, `/api/v1/history` and `/api/v1/events` answer with real data (`history records=4 registry transitions=4`, SSE `seq=1`); the four `page-*.js` modules are served; every write command is a typed refusal and an out-of-vocabulary payload is `HTTP 400`. NOT MET: "real-event-driven animation" — the shipped control daemon binds no Console/Session owner, so no real event can advance the SSE stream (GAP below) |
| A08 registered-online, connection state and execution availability are separate; offline objects and historical connections visible | PASS | 4 | the directory lists five `online` and one `offline` peer at the same moment; live `connections=0` while durable `kind=connection` history holds 4 rows; execution availability is proven from a real engine (`session/new` configOptions) and an unavailable engine exits 1 with `UNSUPPORTED_CONFIGURATION` and no readiness line; the offline object and the historical connections stay visible |
| A09 history across a UI refresh and an owner restart; a non-resumable Session is never passed off as resumed | PASS | 3 | a fresh authenticated stream plus history read returned the same 4 records byte-identical (same `recordId`/`sequence`, no loss or change); after a real control-owner restart (pid 41072 → 65631) the records were still retained byte-identical; a pre-restart Session is refused after the restart with `SESSION_OWNERSHIP_CONFLICT` and `session/load` with `UNSUPPORTED_METHOD` |
| A10 agent-to-agent communication continues after the browser closes and after control stops | PASS | 2 | after every WebUI HTTP/SSE client connection the driver opened was closed, the established LAN channel completed a prompt with `stopReason=end_turn`; with the control daemon stopped and its listener port closed, the same established channel completed a prompt with `stopReason=end_turn`. (The registry-stopped receipt is the third leg of the same family and is counted under A05.) |
| A11 real LAN address; a cross-device conclusion needs a cross-device receipt | GAP | 0 | only one physical host exists here (`192.168.0.3`, tailscale `100.66.1.82`). LAN reachability is proven; a cross-device receipt is not claimed |
| A12 no Work/config/permission regression; install, restart, review and resource close-out | PARTIAL | 3 (install) + 1 (restart, counted in A03) | this driver owns the installed-artifact and restart receipts; `pnpm typecheck` and the three mapped regression suites pass (31 files / 259 tests), while `pnpm verify` is recorded as a blocked gate with live-test flakes (§7). The independent review and the merge/remote/freeze close-out are the integration owner's |

`43` checks = install 3 + A01 6 + A02 3 + A03 5 + A04 5 + A05 7 + A06 2 + A07 5 + A08 4 + A09 3.

## 5. Gaps (real coverage boundaries, not defects)

1. **A07 — animation driven by real events.** The shipped control daemon binds no Console
   owner: `runtime/control-process.ts:756` calls `createControlOwner({ network: network.port })`
   with no `owner`, and the same file hardcodes an empty directory snapshot, so
   `/api/v1/projection` is permanently
   `{version:1, agents:[], sessions:[], notifications:[], configs:[], connections:[]}`.
   No real event can advance the SSE stream in this candidate, so only the SSE transport
   is proven. This is a retained delivery obligation (owner D06/D07), and it is the reason
   A07 is `PARTIAL`.
2. **A07 — live-browser DOM and screenshots.** Headless Chrome cannot satisfy the origin's
   HTTP Basic challenge for a same-origin `fetch`/`EventSource`, and a credentialed origin
   URL is rejected by `fetch` itself; the owner serves no credentials endpoint. The frozen
   DOM marker contract is owned by `ui/teams-console/tests/render-d07.spec.ts` (real
   Chrome), not by this driver. The driver proves the module graph and the HTTP contract.
3. **A07 — targeted interaction from the WebUI.** Because no Session owner is bound, every
   interaction write is a typed `UNSUPPORTED_OPERATION` refusal, so no prompt can be
   targeted from the WebUI in this candidate. The driver proves the refusal is typed and
   that no effect is fabricated; it does not prove a targeted interaction.
4. **A11 — cross-device receipt.** Only one physical host is available. LAN reachability
   over `192.168.0.3` is proven and loopback is never substituted for it; a cross-device
   conclusion is explicitly not claimed.

## 6. Findings (observed product defects; not fixed by this worker)

### D08-F1 — `agentteams control stop` reports `STOP_TIMEOUT` while a WebUI client socket is open

Observed on every canonical run (the `FINDING` line above):

```
agentteams control stop --generation 1 exited 1 with
"STOP_TIMEOUT: control pid=41072 did not exit after SIGTERM" (pid 41072);
the daemon exited shortly after.
```

- Owner: `runtime/control-process.ts` (control daemon shutdown path, ~line 807).
- Root cause: the shutdown promise is `server.close(() => resolveClose())` with no
  `server.closeIdleConnections()` / `server.closeAllConnections()`. `server.close()` only
  stops accepting and waits for existing sockets, so a live keep-alive/SSE WebUI client
  socket holds the process past the CLI's bounded wait. The daemon then exits by itself
  ~0.2–0.4 s later, so the state is consistent — only the CLI receipt is wrong.
- Minimal repro: start a registry and a control daemon, open `/api/v1/events` twice
  (read one frame, `reader.cancel()` each), then
  `agentteams control stop --config control.toml --generation <n>` →
  exit 1, `STOP_TIMEOUT: control pid=<pid> did not exit after SIGTERM`, ~5.17 s; the pid
  disappears ~0.25 s later. Measured variants: one SSE subscription → clean stop in
  269 ms; zero subscriptions → 251 ms; 30 pooled plain requests → 227 ms;
  `reader.cancel()`, `controller.abort()` and 5 pooled requests + 1 SSE all still fail to
  prevent it.
- The driver's A09 step is itself the reproduction: it opens the WebUI SSE stream and
  history reads (A07/A08/A09), then stops the control owner. The driver therefore waits
  for the explicit pid, records the finding, and still asserts the real state
  (`state=stopped`, pid gone, listener port closed).
- Impact: a correct shutdown is reported as a failure to the operator. It does not lose
  history (A09 retention still holds) and does not affect agent-to-agent traffic (A10
  passes while the control daemon is down).

### D08-F2 — the control daemon's projection can never carry real facts

`runtime/control-process.ts:752-754` states that "the daemon binds the owner from its own
real network facts", but line ~756 `createControlOwner({ network: network.port })` passes
no `owner`, and line ~558 hardcodes `directory = {accountId, scopeId, generation: 0,
hosts: [], peerStates: []}`. `/api/v1/projection` is therefore permanently
`{version:1, agents:[], sessions:[], notifications:[], configs:[], connections:[]}`.
This is a documentation/code mismatch plus the root cause of gap 1 and gap 3. It is
reported as a finding rather than fixed, because the product fix belongs to D06/D07.

## 7. Regression gates

`pnpm typecheck` → exit 0.

Mapped regression suites (reused from the D05/D06/D07 evidence inputs; inputs unchanged,
so no unrelated old stage was re-run):

| gate | command | result |
| --- | --- | --- |
| D06 control | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 6 files, 115 tests, pass |
| D05 LAN/network | `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts control-protocol/teams-connection.spec.ts` | 9 files, 73 tests, pass |
| D07 WebUI | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism <16 ui/teams-console/tests specs>` | 16 files, 71 tests, pass |

### `pnpm verify` did not pass on this host — reported as a blocked gate, not as a pass

`pnpm verify` = `pnpm test && pnpm typecheck && appsdk guide compile && appsdk compile &&
pnpm smoke && appsdk verify`. It failed twice, both times in the first step
(`pnpm test` → `scripts/regression.mjs`, vitest `status=1`).

| attempt | failing tests |
| --- | --- |
| 1 | `runtime/managed-opencode-session.spec.ts` "sends one real OpenCode Session request through the selected managed provider" — `TimeoutError: The operation was aborted due to timeout` (13.4 s); `opencode-adapter/tests/acp-engine.real.spec.ts` "cancels a real in-flight prompt through the notification form" — `TypeError: Cannot read properties of undefined (reading 'stopReason')` |
| 2 | `runtime/agent-process.spec.ts` "executes remote Work in an actual Agent process, rejects duplicate ownership and restarts from durable state" — `STACK_TRACE_ERROR` (15.0 s); `runtime/managed-opencode-session.spec.ts` (same test) — `TimeoutError` (13.5 s); `ui/teams-console/tests/focus-dom.spec.ts` "drawer keyboard focus in a real DOM …" — `spawnSync /Applications/Google Chrome.app/Contents/MacOS/Google Chrome ETIMEDOUT` (16.7 s) |

The failing set differs between the two attempts, and **every** failing test passes when
its own file is re-run in isolation: `runtime/agent-process.spec.ts` 40/40 (41.6 s),
`runtime/managed-opencode-session.spec.ts` 1/1 (2.3 s),
`opencode-adapter/tests/acp-engine.real.spec.ts` 4/4 (10.6 s),
`ui/teams-console/tests/focus-dom.spec.ts` 1/1. The failures are resource flakes in live
tests: real Chrome launched through `execFileSync`, real external-provider HTTP timeouts,
and a 15 s real-agent timeout, on a host that concurrently runs other worktrees' debug
daemons.

Attribution: the tree differs from base commit `d37d3b9` only by the added evidence
directory (`git diff` shows no product file; none of the failing specs reads
`docs/evidence/`), so this is not a regression from this change.

- First failing gate: `pnpm test` (vitest).
- Preserved state: the full vitest JSON reports in `/tmp/d08-verify.log` and
  `/tmp/d08-verify2.log`.
- Retry condition: re-run `pnpm verify` on an idle host.
- Owner: the D02/D03/D07 live-test gate owners.
- Next action: re-run `pnpm verify` with no concurrent Chrome or provider load.

A12 therefore stays `PARTIAL`: this worker's own receipts (install, restart, typecheck,
the three mapped suites) are green, and the declared whole-project baseline is recorded as
a blocked gate rather than claimed as a pass.

## 8. Evidence boundary

| level | result |
| --- | --- |
| source | `pnpm build:governance` (which runs `pnpm build`) staged a final package from this tree; exit 0 |
| test | `pnpm typecheck` exit 0; mapped D05/D06/D07 suites 31 files / 259 tests all pass; `pnpm verify` did **not** pass (live-test resource flakes, see §7) |
| build | `mode=final version=0.1.0 files=263`; the recorded `content=d22b43791c31d7e1…` is that run's staged-tree hash |
| installed artifact | `npm pack` tarball ≈1.5 MB → `npm install --prefix` isolated prefix; CLI `realpath` asserted inside the prefix; Teams network modules imported from `generated/runtime-lib` |
| restart | agent A explicit-pid stop → restart → reconnect (A03); control owner restart (A09); registry stop → restart (A03) |
| live | real LAN interface `192.168.0.3` for A04/A05/A10; real `opencode` and `dsh` engines; real configured provider route for DSH |
| browser | **not claimed.** The WebUI is proven as HTTP/SSE transport + module graph + frozen DOM markers; no live-browser DOM or screenshot evidence is produced by this driver (gap 2) |
| review | **not owned by this driver.** The D08 candidate review is the integration owner's |
| merge / remote receipt / freeze | **not owned by this driver.** Nothing is committed by this worker |
| cleanup | every daemon/engine/provider process is stopped by explicit pid in `finally`; the owned temp root is removed on PASS (`cleanup: removed owned root …`); on FAIL the root is retained and its path printed on stderr |

Never inferred: a passing HTTP/transport contract is not browser evidence; a passing
installed smoke is not a cross-device receipt; a passing regression suite is not review.

## 9. Retained objects

No retained process, socket, daemon, temp root or credential file. The owned temp root is
created and removed inside the driver run (`d08-acc-*` under the system temp directory).
The driver starts no process it does not stop by explicit pid, and it never uses `pkill`,
`killall`, `kill $(…)` or `xargs kill`.

Two plain log files are kept outside the repository as the preserved state of the blocked
`pnpm verify` gate: `/tmp/d08-verify.log` and `/tmp/d08-verify2.log` (the full vitest JSON
reports). They are evidence, not owned runtime resources, and they can be deleted once the
gate is re-run on an idle host.
