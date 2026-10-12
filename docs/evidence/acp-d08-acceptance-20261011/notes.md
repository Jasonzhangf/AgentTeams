# D08 final-acceptance run notes — 2026-10-11

Owner: D08 acceptance driver.
Worktree `/Volumes/Intel/playground/agentteams/acp-d08-acceptance-20261011`,
branch `codex/acp-d08-acceptance-20261011`, base commit `d37d3b9` (`origin/main`).
Candidate commits on this branch: `44d82f7` (fix D08-F1), `146824a` (fix D08-F2),
`541f397` (this evidence), `18f4ffe` (D06 evidence repaired after review). The whole
candidate is committed; `origin/main` integration and its remote receipt are separate and
are recorded in `verification.json` (`integration_commit`, `remote_receipt`).

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
code `0`, wall clock 136 s, empty stderr:

```
D08 acceptance PASS: 44 checks (gaps: 4, findings: 1) in 124s
cleanup: removed owned root /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/d08-acc-XXXXXX
```

Three further full runs reached the same `44 checks / 4 gaps` result (`134s`, `133s`, `132s`).
Those runs predate the generation observation, so they printed `findings: 0`; every run from
the one that added it onward prints `findings: 1`. Ports, pids and sessions differ per run
because every run creates its own temp root; the check, gap and finding counts are
deterministic. The pids quoted in this file are the canonical run's.

Two recorded values are *not* stable identities, and are quoted with that caveat:
`content_sha256` changes whenever the staged candidate tree changes (the driver's own
evidence files are part of that tree), and the tarball is 1 516 505–1 516 507 bytes because
its tar header carries the build time. The stable facts are `mode=final`,
`version=0.1.0` and `files=263`.

The driver prints one `PASS <name> — <detail>` per check, `GAP <name> — <reason>` for a
coverage boundary that the candidate cannot prove, and `FINDING <name> — <detail>` for an
observation that falsifies no check. A `FINDING` is usually a product defect, but it can also
be a behaviour worth a decision that no requirement covers. Both product defects this driver
found are now fixed (§6), so no open defect remains. The final run reports `findings: 1` for one
**observation, not a defect**: a graceful `control stop` removes the persisted lifecycle
record, so the restarted owner reuses generation `1` and a stale `--generation` value can
collide with the new lifecycle. The project declares no monotonicity requirement across a
graceful stop, so the driver records this instead of asserting it. A `FINDING` never affects
the exit code. Exit `0` means every check passed; a
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
| A05 bidirectional ACP response/update/callback; cancel and unknown outcome | PASS | 4 | engine→client `session/request_permission` with real options plus client→engine reply released the tool and completed the prompt, with a real `session/update` delivered over LAN; `session/cancel` ended an in-flight prompt with `stopReason=cancelled`; closing a channel mid-prompt left a durable `result.unknown outcome=unknown` and no replay after reconnect; an outstanding callback from the pre-restart engine instance is refused with `CALLBACK_UNAVAILABLE` after the restart |
| A06 blacklist refuses before a side effect; an unexecutable native-tool policy refuses configuration | PASS | 2 | a blacklisted `method:session/set_config_option` was refused with `CAPABILITY_DENIED`, appended no `request.dispatched` record, and left the provider call count unchanged; blacklisting a native tool is refused at configuration time with `UNSUPPORTED_POLICY` for opencode-unknown, foreign-engine and DSH cases |
| A07 WebUI discovery, networking, targeted interaction, history; real-event-driven animation | PARTIAL | 5 | PASS: the authenticated console serves `/`, `/console-entry.js`, `/ui/browser.js`; the barrel-reachable module graph carries 8 frozen DOM markers; `/api/v1/projection`, `/api/v1/history` and `/api/v1/events` answer with real data (`history records=4 registry transitions=4`, SSE `seq=1`); the four `page-*.js` modules are served; every write command is a typed refusal and an out-of-vocabulary payload is `HTTP 400`. NOT MET: "real-event-driven animation" — the shipped control daemon binds no Console/Session owner, so no real event can advance the SSE stream (GAP below) |
| A08 registered-online, connection state and execution availability are separate; offline objects and historical connections visible | PASS | 4 | the directory lists five `online` and one `offline` peer at the same moment; live `connections=0` while durable `kind=connection` history holds 4 rows; execution availability is proven from a real engine (`session/new` configOptions) and an unavailable engine exits 1 with `UNSUPPORTED_CONFIGURATION` and no readiness line; the offline object and the historical connections stay visible |
| A09 history across a UI refresh and an owner restart; a non-resumable Session is never passed off as resumed | PASS | 3 | a fresh authenticated stream plus history read returned the same 4 records byte-identical (same `recordId`/`sequence`, no loss or change); the owner restart goes through the project's own `control stop` + `control start` (not a SIGKILL crash restart), and the durable `kind: 'connection'` history still came back byte-identical; a graceful stop removes the persisted lifecycle record, so the stop+start began a new lifecycle at generation 1 instead of advancing the counter; a pre-restart Session is refused after the restart with `SESSION_OWNERSHIP_CONFLICT` and `session/load` with `UNSUPPORTED_METHOD` |
| A10 agent-to-agent communication continues after the browser closes and after control stops | PASS | 3 | after every WebUI HTTP/SSE client connection the driver opened was closed, the established LAN channel completed a prompt with `stopReason=end_turn`; with the control daemon stopped and its listener port closed, the same established channel completed a prompt with `stopReason=end_turn`; the established channel also completed a prompt while the registry was stopped, which is the third leg of the same family |
| A11 real LAN address; a cross-device conclusion needs a cross-device receipt | PASS | 1 | `PASS A11 — the LAN address is a real, connectable non-loopback listener — 192.168.0.3 is a non-loopback IPv4 and a raw TCP connect to the agent listener 192.168.0.3:57448 succeeded`. The cross-device conclusion is still not claimed: only one physical host exists here (`192.168.0.3`, tailscale `100.66.1.82`) |
| A12 no Work/config/permission regression; install, restart, review and resource close-out | PARTIAL | 3 (install) + 1 (restart, counted in A03/A09) | this driver owns the installed-artifact and restart receipts; `pnpm typecheck` and the three mapped regression suites pass (31 files / 261 tests), while `pnpm verify` is recorded as a blocked gate with live-test flakes (§7). The independent review and the merge/remote/freeze close-out are the integration owner's |

`44` checks = install 3 + A01 6 + A02 3 + A03 5 + A04 5 + A05 4 + A06 2 + A07 5 + A08 4 + A09 3 + A10 3 + A11 1.

The driver passes, but the overall goal stays **INCOMPLETE** while the four gaps in §5 remain.

## 5. Gaps (unmet requirements and evidence boundaries)

Two of these are **unmet requirements**: the shipped control daemon does not provide a
capability D06 requires, so the acceptance item cannot be met in this candidate. Two are
**evidence boundaries**: the capability may exist, but this environment cannot prove it.
Neither kind is a defect introduced by D08, and neither is ever inferred from a passing
check.

1. **A07 — animation driven by real events. UNMET REQUIREMENT, not an environment limit.**
   D06 requires the control daemon to provide discovery query, connect/disconnect, membership
   and role projection, and targeted ACP ingress with callback reply and cancel
   (`D06-control.md`). The shipped daemon binds no Console or Session owner:
   `runtime/control-process.ts:818` calls
   `createControlOwner({ network: network.port, source: network.projection })` with no `owner`,
   so the projection carries no `sessions`, `notifications` or `configs` and no Session-,
   permission- or notification-driven event can advance the SSE stream.
   **The directory half is now real, which supersedes the premise recorded before this gate:**
   since the D06 directory-projection increment (formerly carried as the separate "D09" unit,
   now folded into D06) `/api/v1/projection` carries the real D04 registration-directory agent
   rows and a real registration advances the SSE `seq` (1 -> 3) on the
   `/api/v1/events` stream through the declared `ControlProjectionSource` watch. That
   `seq` advance was observed on the SSE event stream, not on `GET /api/v1/projection`;
   `GET /api/v1/projection` is served by its own read, and the watch polls on its own interval to
   feed the SSE stream. `connections` stays `[]` in this run
   because both feeds are empty: the control daemon declares no Teams listener, so the live ledger has no channel,
   and this run's configuration declares no `[discovery]`, so the directory feed has no peers either. A control
   daemon that does declare `[discovery]` yields real `disconnected` rows from the directory feed alone
   (`runtime/control-process.spec.ts:457-459`), which is why the empty list here is a directory fact about
   this run rather than a fabricated channel.
   Real-event-driven animation is therefore still not delivered — only directory-change-driven
   refresh is. The typed-absence path is deliberate in the shipped code, but the capability it
   stands in for is still missing. This is a retained delivery obligation owned by D06/D07,
   not a coverage boundary. It is the reason A07 is `PARTIAL`.
2. **A07 — live-browser DOM against the installed artifact. EVIDENCE-LEVEL BOUNDARY.**
   The reason recorded here earlier was **wrong**. It claimed headless Chrome cannot satisfy
   the origin's HTTP Basic challenge for a same-origin `fetch`/`EventSource`. That is
   refuted: CDP `Network.setExtraHTTPHeaders` injects the credential at the network layer,
   so a real browser can be driven against a clean-origin URL, and a real producer now does
   exactly that at `docs/evidence/acp-d08-browser-20261011/` (14 checks / 1 gap, exit 0).
   The item nevertheless stays a gap for **this** gate, for a different and correct reason:
   this driver is the installed-tarball, cross-device acceptance layer and it does not drive
   a browser. The live-browser run is a **source-level** artifact driving the worktree CLI
   origin, which is a different evidence level from an installed-artifact run, so it does not
   close this item. The frozen DOM marker contract is also owned by
   `ui/teams-console/tests/render-d07.spec.ts` (real Chrome).
3. **A07 — targeted interaction from the WebUI. UNMET REQUIREMENT, same missing owner as
   gap 1.** Because no Session owner is bound, every
   interaction write is a typed `UNSUPPORTED_OPERATION` refusal, so no prompt can be
   targeted from the WebUI in this candidate. The driver proves the refusal is typed and
   that no effect is fabricated; it does not prove a targeted interaction. Retained delivery
   obligation owned by D06.
4. **A11 — cross-device receipt. EVIDENCE-LEVEL BOUNDARY.** The reason recorded here
   earlier was **wrong**: it said only one physical host is available. A real two-host
   receipt now exists (HOST A `Macstudio.local` `100.66.1.82`, HOST B
   `jennys-macbook-air.anoa-buri.ts.net` `100.93.143.20`, macOS 15.7.9 arm64) in the
   separate A11 unit on branch `codex/acp-a11-crossdevice-20261011` at commit `869aff8`:
   19 checks, 0 gaps, exit 0, real ACP `session/new` → `session/prompt` →
   `session/request_permission` → `session/update` → `end_turn` plus a `session/cancel`
   path, with byte-identical tarball sha256
   `f19211c9bd8123a477e3b99cce3beb23542ea20de80d44b6caf68bab85b80de9` and CLI sha256
   `d97ab857e0a7892f2bab791fbc9a377f9fb12b338c256a6af22e541afd859238` on both hosts.
   It stays a gap for **this** driver because that unit is **not merged** into this
   candidate, so this driver cannot verify it from here and must not claim it. Folding A11
   into this gate requires integrating that unit first. LAN reachability over
   `192.168.0.3` is proven here, and loopback is never substituted for it.

The overall goal stays **INCOMPLETE** while these four gaps remain.

## 6. Defects found by this driver (both fixed), and the one open observation

This driver found two product defects. Both were fixed before the canonical run, so neither
is an open finding. The canonical run reports `findings: 1`, and that single `FINDING` is the
generation-reuse observation described in §1, not a defect: it falsifies no check and no
requirement covers it.

### D08-F1 — `agentteams control stop` reported `STOP_TIMEOUT` while a WebUI client socket was open (FIXED in `44d82f7`)

Observed on the earlier runs:

```
agentteams control stop --generation 1 exited 1 with
"STOP_TIMEOUT: control pid=41072 did not exit after SIGTERM" (pid 41072);
the daemon exited shortly after.
```

- Owner: `runtime/control-process.ts:806` (control daemon shutdown path).
- Root cause: the shutdown awaited `server.close()`, which only stops accepting and then
  waits for the sockets already open, so a live keep-alive/SSE WebUI client socket held the
  daemon past the caller's bounded wait. The daemon then exited by itself ~0.2–0.4 s later,
  so the state was consistent — only the CLI receipt was wrong.
- Minimal repro: start a registry and a control daemon, open `/api/v1/events` twice
  (read one frame, `reader.cancel()` each), then
  `agentteams control stop --config control.toml --generation <n>` →
  exit 1, `STOP_TIMEOUT: control pid=<pid> did not exit after SIGTERM`, ~5.17 s; the pid
  disappears ~0.25 s later. Measured variants: one SSE subscription → clean stop in
  269 ms; zero subscriptions → 251 ms; 30 pooled plain requests → 227 ms;
  `reader.cancel()`, `controller.abort()` and 5 pooled requests + 1 SSE all still failed to
  prevent it.
- Fix: commit `44d82f7` (`fix(control): close the control listener sockets on stop`) also
  calls `server.closeIdleConnections()` and `server.closeAllConnections()`.
- Red test: the new case in `runtime/control-process.spec.ts` opens the real event stream,
  reads one frame, keeps the socket open and stops the daemon. It failed with
  `STOP_TIMEOUT: control pid=<pid> did not exit after SIGTERM` after 5.37 s, and passes now.
- Impact while open: a correct shutdown was reported as a failure to the operator. It never
  lost history (A09 retention still held) and never affected agent-to-agent traffic (A10
  passed while the control daemon was down).

### D08-F2 — the control daemon's durable `kind: 'connection'` history did not survive a stop (FIXED in `146824a`)

Observed after the F1 fix exposed it: a clean stop destroyed the daemon's connection
history, so a restart came back with an empty history page.

- Owner: `runtime/control-process.ts` (`stopControlDaemon` → `removeOwnedState`).
- Root cause: `stopControlDaemon` called `removeOwnedState`, which deleted the daemon's
  whole data directory, and `createControlNetworkStatus` stores the history store in exactly
  that directory (`runtime/control-process.ts:555`, `createAcpHistoryStore({ directory:
  intent.daemon.dataDirectory })`), even though the code comment calls that history durable.
  Every clean stop destroyed it. The defect was masked because the `STOP_TIMEOUT` above
  threw before the removal, so the directory survived by accident; fixing the stop wait
  exposed it.
- Fix: commit `146824a` (`fix(control): keep the durable connection history across a stop`):
  stop now removes only the runtime ownership record and keeps the data directory, matching
  the agent daemon.
- Red test: the new case in `runtime/control-process.spec.ts` writes one real
  connection-history record through the real D05 owner, stops and restarts the daemon, and
  asserts the page returns byte-identical. It failed with
  `expected { records: [] } to deeply equal { records: [ ... ] }`, and passes now.
- This is required by D06 acceptance: "restart 观察和 history 恢复".

### Driver changes made after those fixes

- A09's owner restart now uses the project's own `control stop` + `control start` entries
  (the strict form that exposed D08-F2), not a SIGKILL crash restart.
- The old A10 assertion "the owned data directory is removed by the stop" was removed; it
  encoded the defect.
- The A09 restart generation assertion was corrected: a graceful stop removes the persisted
  lifecycle record, so a stop+start begins a new lifecycle at generation 1 instead of
  advancing the counter (a crash restart keeps the record and advances it). The driver now
  asserts the observed rule.
- A new explicit A11 check was added: the LAN address must be a real non-loopback IPv4 and a
  raw TCP connect to the agent's LAN listener must succeed. In the final run:
  `PASS A11 — the LAN address is a real, connectable non-loopback listener — 192.168.0.3 is a
  non-loopback IPv4 and a raw TCP connect to the agent listener 192.168.0.3:57448 succeeded`.


## 7. Regression gates

`pnpm typecheck` → exit 0. `pnpm build` (inside `pnpm build:governance`) → exit 0.

Mapped regression suites, re-run on this merged candidate (D06 fold + D07 ablation):

| gate | command | result |
| --- | --- | --- |
| D06 control | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 6 files, **118 tests, pass** (117 before the D06 directory-projection increment; that increment adds one real-directory spec case) |
| D05 LAN/network | `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts control-protocol/teams-connection.spec.ts` | 9 files, 73 tests, pass |
| D07 WebUI | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism <the 13 live ui/teams-console/tests specs>` | 13 files, **66 tests, pass** (16 files / 73 tests before the ablation deleted three dead page modules and their specs) |

### 7a. Re-run on the merged candidate (blocked by an upstream outage)

The acceptance driver was re-run on this merged candidate (D06 directory-projection increment
folded in, the A07 gap premise corrected). **Both attempts failed before reaching A07:**

```
FAIL A02 — the real DSH prompt failed: teams-workbuddy API error (503)
  code=no_healthy_account  "no healthy account available in pool; check /status or retry later"
```

Attempt 1 at 21:06 PST and attempt 2 at 21:12 PST failed at the same check with the same
upstream error. Attempt 3 was made at 2026-10-12 05:05 PST on candidate `ea046e0`
(the branch after the evidence corrections) and failed at the identical check with the
identical `no_healthy_account` error. The upstream outage has therefore persisted for
more than eight hours across three attempts on two different candidates, so it is a
sustained provider-side outage rather than a transient. Agent A (`opencode`) completed a real prompt end to end in both attempts
(`stopReason=end_turn`, `providerCalls=3`); agent B (`dsh`) failed only on the provider
gateway returning 503. This is an upstream provider outage, not a defect in this candidate
and not a flake in this project.

Consequences, recorded rather than papered over:

- No new D08 check count is recorded. The 44-check / 4-gap / 1-finding result below is retained
  as the historical run it is, and its A07 premise is corrected above and in
  `verification.json` rather than left stale. The driver was not weakened, skipped, or
  re-scoped to work around the outage; the two attempts before it and this one all
  reached A02 from a clean install of the candidate's own tarball, so the install and
  A01 checks did pass on this candidate.
- The failed runs retained their owned temp roots for inspection; they were verified
  process-free and then removed by name, so no `d08-acc-*` root remains.
- The D06 and D07 mapped gates were re-run green on this candidate (118 and 66 tests), so
  the source-level evidence for the folded increment is fresh.

**Retry policy: stop retrying.** Three identical failures at one check mean the blocker is the
provider pool, not this candidate, so further retries only re-pay the build and install cost.
Re-run once there is an independent signal that the `teams-workbuddy` pool has recovered.
The command is unchanged and the driver stages and installs the tarball by itself. Until
then the D08 gate stays `partial` and the overall goal stays `INCOMPLETE`.

### `pnpm verify` did not pass on this host — reported as a blocked gate, not as a pass

`pnpm verify` = `pnpm test && pnpm typecheck && appsdk guide compile && appsdk compile &&
pnpm smoke && appsdk verify`. It failed twice, both times in the first step
(`pnpm test` → `scripts/regression.mjs`, vitest `status=1`). Both attempts ran before the
two product fixes landed (`44d82f7`, `146824a`); the final candidate's mapped D06 suite
passes at 118 tests (117 before the D06 directory-projection increment added one
real-directory spec case), but the whole-project `pnpm verify` baseline has not been re-run
since, so it stays recorded as a blocked gate rather than claimed as a pass.

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

Attribution: both failing attempts ran on the tree before the two product fixes; none of the
failing specs reads `docs/evidence/`, and the tree at that point differed from base commit
`d37d3b9` only by the added evidence directory (`git diff` showed no product file), so this
was not a regression from this change.

- First failing gate: `pnpm test` (vitest).
- Preserved state: the full vitest JSON reports in `/tmp/d08-verify.log` and
  `/tmp/d08-verify2.log`.
- Retry condition: re-run `pnpm verify` on an idle host.
- Owner: the D02/D03/D07 live-test gate owners.
- Next action: re-run `pnpm verify` with no concurrent Chrome or provider load.

A12 therefore stays `PARTIAL`: this worker's own receipts (install, restart, typecheck,
build, the three mapped suites at 31 files / 261 tests) are green, and the declared
whole-project baseline is recorded as a blocked gate rather than claimed as a pass.

The two product defects this driver found are fixed (`44d82f7`, `146824a`); the overall goal
stays **INCOMPLETE** while the four gaps in §5 remain.

## 8. Evidence boundary

| level | result |
| --- | --- |
| source | `pnpm build:governance` (which runs `pnpm build`) staged a final package from this tree; exit 0 |
| test | `pnpm typecheck` exit 0; mapped D05/D06/D07 suites 31 files / 261 tests all pass; `pnpm verify` did **not** pass (live-test resource flakes, see §7) |
| build | `mode=final version=0.1.0 files=263`. `content_sha256` is **not** a tree identity: re-running the producer on the identical commit gives a different value, because the runner binary is rebuilt into a fresh build directory each run. `docs/evidence/` is not staged into the package at all. The stable identity is the candidate commit, not this hash |
| installed artifact | `npm pack` tarball ≈1.5 MB → `npm install --prefix` isolated prefix; CLI `realpath` asserted inside the prefix; Teams network modules imported from `generated/runtime-lib` |
| restart | agent A explicit-pid stop → restart → reconnect (A03); control owner `control stop` + `control start` (A09); registry stop → restart (A03) |
| live | real LAN interface `192.168.0.3` for A04/A05/A10; real `opencode` and `dsh` engines; real configured provider route for DSH |
| browser | **not claimed.** The WebUI is proven as HTTP/SSE transport + module graph + frozen DOM markers; no live-browser DOM or screenshot evidence is produced by this driver (gap 2) |
| review | **not owned by this driver.** The D08 candidate review is the integration owner's |
| merge / remote receipt / freeze | the candidate is committed on the branch (`44d82f7`, `146824a`, `541f397`, `18f4ffe`); `origin/main` integration, the remote receipt and the freeze are **not owned by this driver** and are recorded in `verification.json` |
| AppSDK compile/verify | **not run by this driver.** D05 records this gate as blocked by `PROJECT_SDK_VERSION_PIN_MISMATCH`; the whole-project `pnpm verify` does not pass on this host (live-test resource flakes), so D08 claims no AppSDK receipt |
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
