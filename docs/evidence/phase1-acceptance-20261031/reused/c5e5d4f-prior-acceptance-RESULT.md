# RESULT — c5e5d4f fresh real acceptance audit

Status: COMPLETE. Six dimensions pass with real evidence. Two dimensions are
`unavailable` because their declared gates are post-MVP (public Relay / direct /
NAT). No product file, map, `.appsdk` entry, package or lock file was changed.
The bug was not closed.

- Base and head: `b7236b2a4dad0308e2769011d71effc0c0bad543`.
- Remote `origin/main`: same commit, checked with `git ls-remote`.
- `f58f6a9` is an ancestor of the head.
- Disposable worktree:
  `/Volumes/Intel/playground/agentteams/c5e5d4f-acceptance-20261029`.
  It was clean before removal and is now removed.
- Evidence root:
  `/Volumes/Intel/playground/agentteams/.worker-runs/c5e5d4f-acceptance-20261029/evidence/`.
- Run date: 2026-10-29 (America/Los_Angeles).

## Acceptance matrix

| # | Dimension | Verdict | First failing node | Raw error |
| --- | --- | --- | --- | --- |
| 1 | Source / test / review / merge | PASS (review scope caveat below) | none | none |
| 2 | Installed artifact / restart | PASS | none | none |
| 3 | Desktop 1440x960 real Chrome | PASS | none | none |
| 4 | Mobile 390x844 real Chrome viewport | PASS (viewport only) | none | none |
| 5 | Direct transport | unavailable (post-MVP) | deployed public path absent | none; not executed |
| 6 | Dual-NAT relay | unavailable (post-MVP) | deployed public path absent | none; not executed |
| 7 | Provider apply / readback on RCC 4444 | PASS (label caveat below) | none | none |
| 8 | Console-offline Agent Work | PASS | none | none |

## 1. Source / test / review / merge

Verdict: PASS for source, tests and merge. Review is PASS at finding scope.
See the review boundary below.

Entrypoints and results:

- `pnpm install --frozen-lockfile` -> exit 0, `Done in 871ms using pnpm v10.31.0`.
- `pnpm build:governance` -> exit 0. Staged final package
  `agentteams@0.2.0-internal.1 5ee5b1264321cc4135000f9dc9aa7c8d06ad28eda06ef326432d7835fbe9e879`
  at `generated/modules/teams-source/lib`.
- `pnpm test` -> exit 0. `Test Files 161 passed`, `Tests 1714 passed`.
- `git rev-parse HEAD` and `git ls-remote origin refs/heads/main` -> both
  `b7236b2a4dad0308e2769011d71effc0c0bad543`.
- `git status --porcelain=v1 --untracked-files=all` -> empty.
- `git merge-base --is-ancestor f58f6a9 HEAD` -> yes, exit 0.

First missing or failing node: none.

Raw error: none.

Evidence:

- `evidence/source/install.log`
- `evidence/source/build-governance.log`
- `evidence/source/pnpm-test.log`
- `evidence/source/git-state.txt`
- `evidence/source/remote-head.txt`
- `evidence/source/package-receipt.json`
- `evidence/source/regression.json`

Review boundary:

- `review-provider-ux-20261029` (base mode, commit `8d1bee3`) listed four P1
  findings: two retry findings in `agent-host/acp-host.ts`, one retry finding in
  `opencode-adapter/src/index.ts`, and one in `runtime/local-config.ts`.
- The project notes state that `review-retry-fixes-20261029` (commit `a6e40f2`)
  covered all modules. It found config, observation and WebUI non-blocking, and
  kept two retry P1 findings.
- `review-retry-fixes-r2-20261029` (commit `d94138f`) returned PASS with zero
  findings for those two retries.
- The last product commit is `f58f6a9` (status-band localization). The project
  notes say it is a presentation-only change in the same milestone and had no
  separate review. Targeted UI tests and typecheck are recorded there.
  My full `pnpm test` run on the final head includes the UI package build and
  its tests, and passed.
- Consequence: no separate overall review verdict exists for the exact final
  product commit. This is a record and boundary item, not a test failure.
  Project governance allows milestone-internal small fixes without a separate
  review.

Prerequisite and owner: local Node 22 and pnpm toolchain; delivery and
integration owner (Jenny) with the author.

Next executable task: the master records this acceptance matrix against the
issue, then decides closeout after review of the record. No code action.

## 2. Installed artifact / restart

Verdict: PASS.

Entrypoint:

`node scripts/installed-runtime-smoke.mjs` with the staged pack root
`generated/modules/teams-source/lib` and a receipt path under
`evidence/installed/`.

The staged final package was packed and installed outside the source tree. The
installed CLI ran `init`, `status`, `start`, `stop` and restart. The receipt
records:

- `lifecycle.status = passed`.
- Start: generation 1, launcher PID 8889.
- Processes: installed relay PID 8890, installed agent processes PID 8891 and
  PID 8966.
- Stop: PID 8889, `state=stopped generation=1`.
- Restart: generation 2, launcher PID 10427.
- Console entrypoints: unauthenticated 401, page 200, console entry 200,
  cross-site 401.

First missing or failing node: none.

Raw error: none.

Evidence:

- `evidence/installed/installed-runtime-smoke.receipt.json`
- `evidence/installed/installed-runtime-smoke.log`

Prerequisite and owner: installed npm tarball path, local host, and the U1
package/lifecycle owner.

Next executable task: reuse this receipt for release admission when the
candidate stays unchanged. No action for acceptance.

## 3. Desktop 1440x960 real Chrome

Verdict: PASS.

Entrypoint:

`C5E5_SOURCE_ROOT=<worktree> node evidence/browser/browser-acceptance.mjs`

The producer used real Chrome (`--headless=new`, own throw-away
`--user-data-dir`), the installed Console from an isolated npm install, and a
network-layer Basic credential. Final run: 19 checks passed, exit 0.

Measured facts:

- Screenshot `1440x960`, 43,578 bytes.
- `innerWidth=1440`, `innerHeight=960`, `scrollWidth=1440`, overflow 0.
- Document 200 with title `AgentTeams Console`.
- `/console-entry.js` and 25 `/ui/` modules returned 200 and byte-matched the
  installed package.
- Page-owned `fetch('/api/v1/projection')` returned 200 with the live agent
  `reasoner-a`.
- Live SSE snapshot `seq=1` reached a driver EventSource.
- All four frozen views switched in the live DOM.
- 0 uncaught page exceptions. The only console error was the expected
  `/favicon.ico` 404.

First missing or failing node: none.

Raw error: none.

Evidence:

- `evidence/browser/browser-acceptance.receipt.json`
- `evidence/browser/browser-acceptance.log`
- `evidence/browser/desktop-1440x960.png`

Prerequisite and owner: local Chrome binary and an installed Console origin;
WebUI owner (`ui/teams-console`) with the console host owner.

Next executable task: attach the screenshot and receipt to the issue. No code
action.

## 4. Mobile 390x844 real Chrome viewport

Verdict: PASS for viewport emulation. Cellular behavior is not proven.

Entrypoint: same browser producer as dimension 3, with mobile emulation
`width=390`, `height=844`, `deviceScaleFactor=2`, `mobile=true`.

Measured facts:

- Screenshot PNG `780x1688` (DPR 2), 72,218 bytes; CSS viewport `390x844`.
- `innerWidth=390`, `innerHeight=844`, `scrollWidth=390`, overflow 0.
- All four views and the real agent row `reasoner-a` were visible.
- No page exceptions.
- Receipt states `viewport emulation only (not cellular)`.

First missing or failing node: none for the viewport claim. A cellular claim
needs a real device and was not attempted.

Raw error: none.

Evidence:

- `evidence/browser/mobile-390x844.png`
- `evidence/browser/browser-acceptance.receipt.json`
- `evidence/browser/browser-acceptance.log`

Prerequisite and owner: WebUI owner; a real device or cellular environment
owner for any future cellular claim (not provided).

Next executable task: provide one real mobile device with a cellular or Wi-Fi
LAN path, then replay the same entrypoint. Until then, keep the viewport-only
boundary in the issue record.

## 5. Direct transport

Verdict: `unavailable`.

Declared gate: `teams-peer-work-execution-public-nat` in the verification map.
Status `design`, `required=false`, `phase=post-mvp`.

Reason: no deployed public transport and no real NAT egress exist in this
environment. Project governance defers public Relay, direct transport and
STUN/ICE to post-MVP gates. No health check or mock was substituted.

First missing or failing node: deployed public transport and NAT egress.

Raw error: none; the gate was not executed.

Evidence:

- `evidence/transport/verification-map-gates.json`
- `docs/development-governance.md` (post-MVP boundary)

Prerequisite and owner: network owner plus deployment and infrastructure owner.

Next executable task: provide a deployed public endpoint and one real NAT
egress, then run
`pnpm exec vitest run packages/shared/src/work-wire.spec.ts agent-host/work-host.spec.ts agent-host/cli-executor.spec.ts network/relay-client.spec.ts runtime/agent-process.spec.ts`
and bind the public replay receipt.

## 6. Dual-NAT relay

Verdict: `unavailable`.

Declared gate: `teams-relay-process-deployment-public` in the relay
verification map. Status `design`, `required=false`, `phase=post-mvp`.

Reason: no packaged public Relay deployment and no NAT-to-NAT link exist. The
local Relay process gate is present and remains `partial` by design; it does
not prove public deployment.

First missing or failing node: public Relay deployment receipt and NAT-to-NAT
transport.

Raw error: none; the gate was not executed.

Evidence:

- `evidence/relay/verification-map-gates.json`
- `docs/development-governance.md` (post-MVP boundary)

Prerequisite and owner: server and Relay owner plus infrastructure and NAT
owner.

Next executable task: deploy the packaged Relay on a public host, bind its
installation and public-entrypoint receipts, then replay a dual-NAT Work path
through it.

## 7. Provider apply / readback on RCC 4444

Verdict: PASS.

Entrypoint:

`node scripts/blackbox-user-mvp.mjs --case BB08,BB10 --receipt evidence/provider/bb08-bb10.receipt.json --evidence-dir evidence/provider/cases`

Results: `exit.code=0`, `failed=[]`, `unverified=[]`. BB08 and BB10 both passed.

- BB08: installed `config.toml` is the single source; edit produced source
  revision 2 to 3 and generation 1 to 2; a stale generation submit failed with
  a typed error; duplicate query returned the prior result; a stale provider
  generation 99 failed with a typed error.
- BB10: two real provider turns completed through
  `http://127.0.0.1:4444/v1`; explicit primary/backup selection was accepted at
  revision 2; restart moved launcher generation 1 to 2 while accepted revision
  stayed 2; readback showed `applyState=clean` and the same accepted binding.
- Readback providers: `rcc-4444` with `apiBaseUrl=http://127.0.0.1:4444/v1`
  and `goaichat` (label `GoAIChat OpenAI`) with the same
  `apiBaseUrl=http://127.0.0.1:4444/v1` and bearer auth.

Caveat that must stay in the record: the provider instance id `goaichat` and
its label are misleading. Its effective base URL is the local RCC endpoint on
port 4444. Every turn in BB10 used 4444. No external Goaichat host was
contacted. The contract condition `RCC 4444 only` is met at the transport
level, but the label should be renamed later to prevent misreading.

First missing or failing node: none.

Raw error: none.

Evidence:

- `evidence/provider/bb08-bb10.receipt.json`
- `evidence/provider/bb08-bb10.log`
- `evidence/provider/cases/cases/BB08/`
- `evidence/provider/cases/cases/BB10/`
- `evidence/provider/rcc-models.json`

Prerequisite and owner: local RCC endpoint at `127.0.0.1:4444`; config and
provider owner (U2/U6).

Next executable task: optionally rename the `goaichat` instance label to avoid
ambiguity in later acceptance records. No code change is needed for this
acceptance.

## 8. Console-offline Agent Work

Verdict: PASS.

Entrypoint: installed CLI lifecycle and Work commands against an installed
temporary stack:

- `agentteams console start` and `agentteams console stop` with the installed
  config.
- `agentteams work submit`, `work query`, `work open`, `work request` and
  `work close` while the Console was stopped.

The receipt records:

- Console online with generation 1, PID 8992; unauthenticated 401; authenticated
  200; cross-site 401.
- Stop left launcher and daemons unchanged (`launcherAndDaemonsUnchanged=true`).
- Work completed while the Console was offline:
  `workId=ed5d14bc-b053-490b-a810-b3c1386b677d`, state `succeeded`, business
  `status=matched`, exit code 0.
- A persistent Work open and request stayed `retained`; the later close set
  `closed`. A lost socket returned `failed` with `deliveryState=unconfirmed`.
- Console restart returned to `online` at generation 2 with a new PID.
- An unsupported flag was rejected (`forbiddenFlagRejected=true`).

First missing or failing node: none.

Raw error: none.

Evidence:

- `evidence/installed/console-offline.json`

Evidence boundary: the receipt is preserved, but its producer script is not.
The exact CLI entrypoints and IDs are in the receipt. A replay needs a rebuilt
installed stack.

Prerequisite and owner: installed stack and local host; U5 console lifecycle
owner with the runtime and Work owner.

Next executable task: record this receipt in the issue and keep the Work IDs
for later readback. No code action.

## Environment and process facts

- Real Chrome was used for both screenshots. The mobile run is viewport
  emulation only.
- Vikunja was not started and was not needed for these dimensions.
- The l13-test Console (`PID 90163`) and registry (`PID 87339`) were not used
  and not changed. No tmux action was taken.
- Two earlier browser runs failed at `agent start` with
  `ENGINE_UNAVAILABLE: cannot listen on the local group message socket: ENOENT`
  because of a long temporary socket path. A short `mkdtemp` root fixed it.
  Those failures were harness errors, not product defects. Their logs are kept
  as `browser-acceptance.failed-1.*` and `.failed-2.*`.
- Older `/tmp/agentteams-u7-*` and `/var/folders/.../atckC6dk` resources predate
  this run or belong to another owner. They were not touched.

## Cleanup

- All owned PIDs were checked with `kill -0` and are gone:
  8889, 8890, 8891, 8966, 8992, 10427, 10465, 10499, 10546, 97519, 97520,
  97524, 98119, 98405.
- The disposable worktree was removed with
  `git worktree remove /Volumes/Intel/playground/agentteams/c5e5d4f-acceptance-20261029`
  and `git worktree prune`. The path no longer exists. The only remaining
  worktree is the main checkout at `b7236b2`.
- Owned temporary roots are gone: `c5-gTNeyk`, `atenkMFX`,
  `agentteams-u7-bb10-GrTZQu`, and the two failed-attempt
  `l11-installed-browser-*` roots.
- Cleanup record: `evidence/cleanup.json`.

## First failing gate, retry policy, owner, next action

There is no failing gate for dimensions 1, 2, 3, 4, 7 and 8.

Dimensions 5 and 6 are not failures. They are `unavailable` because their gates
are post-MVP and their prerequisites do not exist:

- First failing node: absent public transport, NAT and Relay deployment.
- Preserved state: no stack was started for these dimensions; no mock evidence
  was produced.
- Retry policy: retry only after the deployment owner provides a real public
  endpoint and NAT path.
- Owner: network and Relay owners with the infrastructure owner.
- One executable next action: deploy one public Relay or direct endpoint, then
  run the `*-public-nat` gate command from the map.

## Evidence index

- Source and tests: `evidence/source/`
- Review receipts and project notes: `evidence/review/`
- Installed lifecycle: `evidence/installed/`
- Browser desktop and mobile: `evidence/browser/`
- Provider BB08/BB10: `evidence/provider/`
- Direct and NAT map extracts: `evidence/transport/`, `evidence/relay/`
- Cleanup: `evidence/cleanup.json`

