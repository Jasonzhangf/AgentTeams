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

Canonical run of this unit (final artifact state, all three files in this directory
present), exit code `0`, wall clock 136 s, empty stderr. **This is the run at the commit
that produced the artifacts below; it predates the driver's A02 retry and the A11 merge.**
The current result on this candidate is in §7c (45 checks / 3 gaps / 2 findings, 278 s):

```
D08 acceptance PASS: 44 checks (gaps: 4, findings: 1) in 124s
cleanup: removed owned root /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/d08-acc-XXXXXX
```

Three further full runs reached the same `44 checks / 4 gaps` result (`134s`, `133s`, `132s`).
Those runs predate the generation observation, so they printed `findings: 0`; every run from
the one that added it onward prints `findings: 1`. Ports, pids and sessions differ per run
because every run creates its own temp root. The pids quoted in this file are the canonical
run's.

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
| A02 OpenCode and DSH each complete a real prompt/process/reply | PASS | 3 | OpenCode: real `opencode acp --pure` child of the installed daemon, `session/new` → `session/prompt` → real `session/request_permission` (once/always/reject) → reply → `stopReason=end_turn`, provider served the turn. DSH: real `dsh` child, `initialize` + `session/new`, then `session/prompt` → `stopReason=end_turn` over the real configured `teams-workbuddy` route — on **attempt 3** of the exponential-backoff retry, after attempts 1 and 2 were refused with upstream 503 `no_healthy_account` |
| A03 config names the server; automatic registration, heartbeat, lease offline, restart and reconnect | PASS | 5 | registration is automatic against `wss://127.0.0.1:<port>` with no manual step; `lastSeenAt` advanced over a 15 s heartbeat window; the server-owned lease (`peerTtlMs=90_000`) published `lease-probe` as `presence=offline` while its registration socket stayed online; explicit-pid stop → entry retained `offline` → restart → `online` with a new pid; registry stop → the daemon reports a degraded registration state and keeps naming its configured endpoint → registry restart → `online` again |
| A04 discover, authenticate, negotiate, connect; both sides know the role; role grants no extra authority | PASS | 5 | a wrong credential is refused at the transport (`network: WSS connection failed`) with no `connection.negotiated` record; negotiation reaches `state=agreed` with `policyRevisions=3/1` over the real LAN listener; both sides report the same `master->peer` agreement; the same daemon serves `master/peer` on one leg and `peer/master` on the other; the master leg and the peer leg are both refused `session/load` with `UNSUPPORTED_METHOD` |
| A05 bidirectional ACP response/update/callback; cancel and unknown outcome | PASS | 4 | engine→client `session/request_permission` with real options plus client→engine reply released the tool and completed the prompt, with a real `session/update` delivered over LAN; `session/cancel` ended an in-flight prompt with `stopReason=cancelled`; closing a channel mid-prompt left a durable `result.unknown outcome=unknown` and no replay after reconnect; an outstanding callback from the pre-restart engine instance is refused with `CALLBACK_UNAVAILABLE` after the restart |
| A06 blacklist refuses before a side effect; an unexecutable native-tool policy refuses configuration | PASS | 2 | a blacklisted `method:session/set_config_option` was refused with `CAPABILITY_DENIED`, appended no `request.dispatched` record, and left the provider call count unchanged; blacklisting a native tool is refused at configuration time with `UNSUPPORTED_POLICY` for opencode-unknown, foreign-engine and DSH cases |
| A07 WebUI discovery, networking, targeted interaction, history; real-event-driven animation | PARTIAL | 5 | PASS: the authenticated console serves `/`, `/console-entry.js`, `/ui/browser.js`; the barrel-reachable module graph carries 8 frozen DOM markers; `/api/v1/projection`, `/api/v1/history` and `/api/v1/events` answer with real data (`history records=4 registry transitions=4`, SSE `seq=1`); the four `page-*.js` modules are served; every write command is a typed refusal and an out-of-vocabulary payload is `HTTP 400`. NOT MET: "real-event-driven animation" — the shipped control daemon binds no Console/Session owner, so no real event can advance the SSE stream (GAP below) |
| A08 registered-online, connection state and execution availability are separate; offline objects and historical connections visible | PASS | 4 | the directory lists five `online` and one `offline` peer at the same moment; live `connections=0` while durable `kind=connection` history holds 4 rows; execution availability is proven from a real engine (`session/new` configOptions) and an unavailable engine exits 1 with `UNSUPPORTED_CONFIGURATION` and no readiness line; the offline object and the historical connections stay visible |
| A09 history across a UI refresh and an owner restart; a non-resumable Session is never passed off as resumed | PASS | 3 | a fresh authenticated stream plus history read returned the same 4 records byte-identical (same `recordId`/`sequence`, no loss or change); the owner restart goes through the project's own `control stop` + `control start` (not a SIGKILL crash restart), and the durable `kind: 'connection'` history still came back byte-identical; a graceful stop removes the persisted lifecycle record, so the stop+start began a new lifecycle at generation 1 instead of advancing the counter; a pre-restart Session is refused after the restart with `SESSION_OWNERSHIP_CONFLICT` and `session/load` with `UNSUPPORTED_METHOD` |
| A10 agent-to-agent communication continues after the browser closes and after control stops | PASS | 3 | after every WebUI HTTP/SSE client connection the driver opened was closed, the established LAN channel completed a prompt with `stopReason=end_turn`; with the control daemon stopped and its listener port closed, the same established channel completed a prompt with `stopReason=end_turn`; the established channel also completed a prompt while the registry was stopped, which is the third leg of the same family |
| A11 real LAN address; a cross-device conclusion needs a cross-device receipt | PASS | 2 | `PASS A11 — the LAN address is a real, connectable non-loopback listener` (192.168.0.3 is a non-loopback IPv4 and a raw TCP connect to the agent listener succeeded) plus `PASS A11 — the cross-device receipt is integrated and recorded gap-free` (19 checks / 0 gaps, hosts `Macstudio.local` and `jennys-macbook-air.anoa-buri.ts.net`, byte-identical tarball and installed CLI on both). The cross-device conclusion is claimed through that integrated evidence, and the residual boundary is recorded as a finding rather than a gap (§5a) |
| A12 no Work/config/permission regression; install, restart, review and resource close-out | PARTIAL | 3 (install) + 1 (restart, counted in A03/A09) | this driver owns the installed-artifact and restart receipts; `pnpm typecheck` and the three mapped regression suites pass (31 files / 261 tests), while `pnpm verify` is recorded as a blocked gate with live-test flakes (§7). The remaining A12 obligations are now **complete**: the independent review is PASS (round 3 at `4b058e6`, findings fixed in `b82affd`), the candidate is integrated at `f5a54ae` by fast-forward with the remote receipt read back, the frozen `control-protocol/` tree is byte-identical to the pre-integration main, and the five owned worktrees are removed and their claims released (§7d) |

`45` checks = install 3 + A01 6 + A02 3 + A03 5 + A04 5 + A05 4 + A06 2 + A07 5 + A08 4 + A09 3 + A10 3 + A11 2 + A12 3. The 44 in §1 is the historical run before the A11 receipt check and the A12 install/restart rows it counted separately. The counts have been stable across every completed run since: only the gap set changed, as A11 closed and then A02 closed.

The driver passes, but the overall goal stays **INCOMPLETE** while the three gaps in §5 remain.

## 5. Gaps (unmet requirements and evidence boundaries)

Two of these are **unmet requirements**: the shipped control daemon does not provide a
capability D06 requires, so the acceptance item cannot be met in this candidate. One is an
**evidence boundary**: the capability may exist, but this environment cannot prove it. None is
a defect introduced by D08, and none is ever inferred from a passing check.

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
   interaction write (`permission.reply`/session send) is a typed `UNSUPPORTED_OPERATION` refusal, so no prompt can be
   targeted from the WebUI in this candidate. The driver proves the refusal is typed and
   that no effect is fabricated; it does not prove a targeted interaction. Retained delivery
   obligation owned by D06.
### 5a. Gaps closed on this candidate

**A02 — DSH real inference — CLOSED.** This was the only non-D06 gap, and it closed because the retry was in the driver. The upstream `teams-workbuddy` pool refused every attempt of the five earlier runs on 2026-10-11 21:06, 21:12 and 2026-10-12 05:05, 06:07, 06:31 with `API error (503)` / `no_healthy_account`, and an unclassified shape of the same outage (`Internal error: turn failed: Connection error.`) aborted a fourth run at 07:31. That is what the in-driver exponential backoff was for: a transient provider refusal is not a candidate defect, and the operator should not have to re-pay a whole build and install because one request was refused.

Concretely, the retry went through three fixes. `d8f5cd1` retried the prompt up to six times with a fresh request id per attempt and backoff of 30 s / 60 s / 120 s / 240 s / 480 s, only retrying a 5xx-shaped provider refusal. `d05f3a0` then added the second observed upstream shape, `turn failed: Connection error`, and retried a no-frame timeout only while the engine process was still alive — a dead engine returns immediately and fails fast, because retrying a crash would hide it and cost five minutes of backoff first. At 2026-10-12 07:56 the pool refused attempts 1 and 2 and **served attempt 3** with `stopReason=end_turn` over the real provider route, so the run that would previously have died at A02 passed it. Every candidate defect still fails on the first attempt: a typed refusal or JSON-RPC error arrives as a frame and none of `CONFLICT`, `SESSION_OWNERSHIP_CONFLICT`, `ENGINE_UNAVAILABLE`, `CALLBACK_UNAVAILABLE`, `RESULT_UNKNOWN`, `CAPABILITY_DENIED` or `-32601`/`-32602` matches the transient matcher.

**A11 — cross-device receipt — CLOSED.**



The A11 gap is **closed** on this candidate. The reason it was open is recorded here so the
change stays auditable: it was open because the two-host receipt lived in a **separate,
unmerged** unit, so this driver could not verify it from here. That unit is now merged into
this candidate at commit `869aff8`, and the driver verifies the receipt instead of carrying a
gap. The check asserts the receipt is present, records at least two checks, records **no**
gaps, and names two **distinct non-loopback** hosts (`Macstudio.local`,
`jennys-macbook-air.anoa-buri.ts.net`). The receipt itself is unchanged from the A11 unit:

- 19 checks, 0 gaps, exit 0, real ACP `session/new` → `session/prompt` →
  `session/request_permission` → `session/update` → `end_turn`, plus a `session/cancel` path.
- byte-identical tarball sha256
  `f19211c9bd8123a477e3b99cce3beb23542ea20de80d44b6caf68bab85b80de9` and CLI sha256
  `d97ab857e0a7892f2bab791fbc9a377f9fb12b338c256a6af22e541afd859238` on both hosts.

The residual boundary is recorded as a **finding**, not a gap: this driver verified the receipt
**by reading it**. It did not re-drive the cross-device traffic, because it exercised only
`192.168.0.3` (tailscale `100.66.1.82`). Loopback and same-host non-loopback are still never
substituted for a cross-device result. The A11 unit's own self-declared limits are unchanged
and are **not** repaired by merging it: the registry runs on HOST A, HOST B's engine is a copy
rather than an install, the provider is a stub, the path is Tailscale rather than the ordinary
LAN, and the two hosts' physical distinctness is attested only by hostname.

The overall goal stays **INCOMPLETE** while these three gaps remain.

## 6. Defects found by this driver (both fixed), and the one open observation

This driver found four product defects. All were fixed on this candidate, so none is an open
finding. The current run reports `findings: 2`, and neither `FINDING` is a defect: one is the
generation-reuse observation described in §1, and one is the A11 note that the cross-device
receipt is verified by reading rather than by re-driving the traffic (§5a). Neither falsifies a
check, and no requirement covers the first.

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


### D08-F3 — the acceptance driver aborted the whole run on a single transient upstream refusal (FIXED in `d8f5cd1`)

The driver made one attempt at the A02 DSH prompt and threw on any error. The upstream
`teams-workbuddy` pool returned `API error (503)` / `no_healthy_account`, so runs at 2026-10-11
21:06, 21:12 and 2026-10-12 05:05 died at A02 and produced **no** A03-A11 result at all. This is
a driver-robustness defect, not an orchestration decision: one transient error must not end a run
that a retry would close, and the operator should not re-pay a whole build and install for it.
Fixed by retrying with exponential backoff and a fresh request id per attempt, retrying only a
5xx-shaped provider refusal, and recording a gap (never a pass) when every attempt is refused.

### D08-F4 — the retry did not recognise the second upstream shape, and treated a stall as fatal (FIXED in `d05f3a0`)

A fourth run failed at A02 with `Internal error: turn failed: Connection error.` — the same
outage in a second shape the matcher did not know, so it was classified as a deterministic defect
and aborted the run. The same run showed a second weakness: no frame at all was a hard failure
even though a stall is exactly what an outage looks like. Fixed by classifying the second shape
as transient and by retrying a no-frame timeout **only while the engine process is still alive**;
a dead engine returns immediately and fails fast, because retrying a crash would hide it and cost
five minutes of backoff first.

## 7. Regression gates

`pnpm typecheck` → exit 0. `pnpm build` (inside `pnpm build:governance`) → exit 0.

Mapped regression suites, re-run on this merged candidate (D06 fold + D07 ablation):

| gate | command | result |
| --- | --- | --- |
| D06 control | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 6 files, **118 tests, pass** (117 before the D06 directory-projection increment; that increment adds one real-directory spec case) |
| D05 LAN/network | `pnpm exec vitest run --no-file-parallelism network/teams-negotiation.spec.ts network/teams-session.spec.ts network/teams-connection-history.spec.ts network/teams-membership.spec.ts network/registration-client.spec.ts runtime/registry-registration.spec.ts network/teams-ingress.spec.ts network/teams-status.spec.ts control-protocol/teams-connection.spec.ts` | 9 files, 73 tests, pass |
| D07 WebUI | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism <the 13 live ui/teams-console/tests specs>` | 13 files, **66 tests, pass** (16 files / 73 tests before the ablation deleted three dead page modules and their specs) |

### 7a. Re-runs on the merged candidate (the outage moved from the driver to a gap)

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

Consequences at the time, superseded by §7b — recorded rather than papered over:

- No new D08 check count was recorded **at that point**, because the driver could not get
  past A02. §7b supersedes this bullet: after the retry fix the run does complete, and the
  44-check / 4-gap / 1-finding result above stays as the historical run it is, with its A07
  premise corrected above and in `verification.json` rather than left stale. The driver was
  never weakened, skipped, or re-scoped to work around the outage: every attempt reached
  A02 from a clean install of the candidate's own tarball, so the install and A01 checks
  passed on this candidate.
- The failed runs retained their owned temp roots for inspection; they were verified
  process-free and then removed by name, so no `d08-acc-*` root remains.
- The D06 and D07 mapped gates were re-run green on this candidate (118 and 66 tests), so
  the source-level evidence for the folded increment is fresh.

**Retry policy — corrected. The earlier policy was wrong and the driver was wrong.** This
section first recorded "stop retrying" and treated the outage as a reason to stop running the
driver. That is the wrong place to put a retry: a driver that dies on one upstream error
throws away every result behind it and makes the operator re-pay the whole build and install.
A single transient error must be retried **inside** the driver, with exponential backoff, so
the same failure cannot end a run that a retry would have closed. Fixed in commit `d8f5cd1`:
the A02 DSH prompt is attempted up to six times with a fresh request id per attempt and
backoff of 30 s, 60 s, 120 s, 240 s and 480 s. Only a 5xx-shaped provider refusal is retried,
so a real candidate defect still fails fast and loudly instead of being retried into an
ambiguous result. When every attempt refuses, the driver records the prompt as a **gap** and
still claims the `initialize`/`session/new` result it did prove, so the run continues through
A03–A11 and neither path is a fabricated pass.

### 7b. Run 4 on the merged candidate (2026-10-12 06:31 PST) — superseded by §7c

Run 4 proved the run completes instead of dying at A02. It is retained as its own record, but
its `gaps: 4` includes the A02 prompt, which §7c then closed.

Commit `d8f5cd1` (retry) plus the A11 merge `869aff8`, tree clean:

```
D08 acceptance PASS: 45 checks (gaps: 4, findings: 2) in 1188s
```

All six A02 DSH attempts were refused with the same `no_healthy_account` 503, so the upstream
outage is real and sustained — but it no longer stops the run. The result moved in three ways,
and each is a correction rather than a cosmetic change:

- **The run reaches the end.** It previously died at A02 and produced no A03–A11 result at all.
  The full A01–A11 result now exists on this candidate.
- **The A11 cross-device gap is closed** by the merged receipt (see §5a) and replaced by a
  check plus a finding.
- **A02 DSH real inference became a gap.** The honest consequence of not dying: the run now
  states plainly that no prompt result is claimed for agent B, instead of reporting nothing.

Checks rose 44 → 45 (the A11 check), findings 1 → 2 (the A09 generation-1 observation plus the
A11 read-not-drive finding), and the gap set changed membership rather than count (A11 out,
A02 in). The later driver change to verify an integrated receipt is `git show`-able in
`black-box-acceptance.mjs`, and the earlier 44-check run stays recorded as its own run.

The D08 gate stays `partial` and the overall goal stays `INCOMPLETE`, because the D06
write-side requirements behind the A07 gaps are still unmet and no ACP gate has been upgraded.

### 7c. Run 5 on the merged candidate (2026-10-12 07:56 PST) — the retry closed the outage

Commit `d05f3a0` (both upstream shapes classified; a stalled engine discriminated from a dead
engine), tree clean:

```
D08 acceptance PASS: 45 checks (gaps: 3, findings: 2) in 278s
```

This is the definitive result. The upstream pool refused **attempts 1 and 2** and then **served
attempt 3** with `stopReason=end_turn` over the real `teams-workbuddy` route, so **A02 DSH real
inference closed mid-run**. Both engines now complete a real prompt through the installed CLI,
and the gap set is the three A07 items only.

That is the whole point of putting the retry in the driver. A run that treats one upstream
refusal as fatal dies at A02, throws away every result behind it, and makes the operator re-pay
the build and install — and it reports the outage as if it were a property of the candidate.
With the retry, the same outage costs 90 s of backoff and the run passes. The classification is
narrow enough that a real defect is still not retried: only the two observed upstream shapes
(`API error (503)` / `no_healthy_account`, and `turn failed: Connection error`) and a no-frame
timeout while the engine is still alive are retried, and a typed refusal or JSON-RPC error
reaches the caller on the first attempt.

The D08 gate stays `partial` and the overall goal stays `INCOMPLETE`, for the A07 reasons above:
the D06 write-side requirements are still unmet, the live-browser DOM evidence is source-level
only, and no ACP gate has been upgraded.

### 7d. Close-out

All A12 obligations that were previously open are now complete:


```text
review            PASS — round 3 at 4b058e6 (read-only, covering d8f5cd1, 1a639a7 and 4b058e6)
findings          F1 stale A02/A11 table rows, F2 stale header comment — both fixed in b82affd
candidate gate    pnpm build:governance exit 0 · pnpm typecheck exit 0
                  D06 gate 6 files / 118 tests · D07 gate 13 files / 66 tests
                  D08 acceptance 45 checks / 3 gaps / 2 findings, exit 0, 278s
frozen contract   git diff origin/main -- control-protocol/ empty — the contract is untouched
integration       fast-forward 3c21d6f -> f5a54ae, 24 commits, no merge commit, no rewrite
remote receipt    git ls-remote origin refs/heads/main read back after every push
worktrees         5 owned worktrees removed, claims released
```

Owned worktrees reclaimed (all five were merged into main, clean, and their paths resolved to the expected locations before removal):

| worktree | commit | state before removal |
| --- | --- | --- |
| `acp-d08-browser-20261011` | `f5a54ae` | merged, clean, 1.6 GB |
| `acp-a11-crossdevice-20261011` | `869aff8` | merged, clean, 737 MB |
| `acp-test-audit-d06-20261011` | `e77d9d7` | merged, clean, 155 MB |
| `acp-test-audit-d07-20261011` | `e77d9d7` | merged, clean, 153 MB |
| `acp-d06-d09-fold-20261011` | `3c21d6f` | merged, clean, 155 MB |

All were my own `codex/acp-*` work of this delivery, verified as ancestors of main and free of uncommitted changes before `git worktree remove`. No other worktree was touched, so 30 remain in the playground, owned by other units. The two remote branches this delivery created were kept as their branches of record: `codex/acp-d08-browser-20261011` and `codex/acp-d00-contract-20261010`.

One gate remains recorded as blocked and is not closed here: `pnpm verify`. Its failure is pre-recorded as live-test flakes, and the three product defects it would have exercised were each found and fixed by this driver instead, so the gate's status does not move. The A07 gaps are unmet requirements, not flakes, and they are what keeps this gate and the overall goal partial.

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

The four product defects this driver found are fixed (`44d82f7`, `146824a`, `d8f5cd1`,
`d05f3a0`); the overall goal stays **INCOMPLETE** while the three gaps in §5 remain.

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
