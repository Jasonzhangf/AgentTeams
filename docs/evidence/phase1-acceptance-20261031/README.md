# Phase 1 V1 acceptance evidence at 6d7dcf9

This directory records the Phase 1 V1 acceptance evidence for the three open
bugs `c5e5d4f`, `8ea5f7c` and `3c437d7`. The run used only real local
entrypoints on the exact candidate. It did not modify product source, maps,
`.appsdk`, package or lock files. It did not merge, push, or close any bug.

## Identity

- origin/main: `6d7dcf9d19bba415aa566b910cc4ec472ae2bf44`
- HEAD: `6d7dcf9d19bba415aa566b910cc4ec472ae2bf44`
- tree: `f22bf13a2da37a4f04add2a97460794bc18fe216`
- branch: `codex/phase1-acceptance-20261031`
- worktree: `/Volumes/Intel/playground/agentteams/phase1-acceptance-20261031`
- run date: 2026-10-31 (America/Los_Angeles)
- merge commit parents: `b7236b2` (mainline) and `0bb9c97` (read-only config
  surface). `0bb9c97` is an ancestor of `6d7dcf9`.

The source receipt `source/package-receipt.json` records
`candidate.head_commit=6d7dcf9`, `tree_hash=f22bf13a`, `source_state=committed`,
`mode=final`, `release_eligible=false`, `files=317`, and
`content_sha256=0ae9cd4273fa2ce5ec423b4ccabf6efe9a48c8bbdb528f10995a5be01ec0197d`.

## What ran on this tree

| Gate | Entrypoint | Result |
| --- | --- | --- |
| Dependency install | `pnpm install --frozen-lockfile` | exit 0 |
| Type check | `pnpm typecheck` | exit 0 |
| Full tests | `pnpm test` | 162 test files passed, 1714 tests passed, exit 0 |
| Governance build | `pnpm build:governance` | exit 0; final package staged |
| Installed runtime smoke | `node scripts/installed-runtime-smoke.mjs --pack-root generated/modules/teams-source/lib --receipt-path ...` | exit 0; lifecycle passed |
| Real Chrome DOM | `node browser-acceptance.mjs` | 20 checks passed, exit 0 |
| Real screenshots | same producer | desktop `1440x960`, mobile `390x844` (DPR 2) |

The installed smoke receipt records a real installed Relay plus two Agent
processes. Start was generation 1 with launcher PID 34834, Relay PID 34835,
provider PID 34861, receiver PID 34949. Stop returned `state=stopped
generation=1`. Restart was generation 2 with launcher PID 36898, Relay PID
36901, provider PID 36902, receiver PID 36932. Console entrypoints returned
401, 200, 200, 200, 200 and cross-site 401. The same receipt records the
Console lifecycle and the Console-offline Work replay: Console online at
generation 1 PID 35052, stop left launcher and daemons unchanged, Work after
the Console stop completed (`workId=471d8c64-c725-4750-a067-afda644838bd`,
`requestState=succeeded`, business `matched`, exit 0), Console restart returned
online at generation 2 with a changed PID, and a forbidden Console flag was
rejected.

## Acceptance matrix

| # | Dimension | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Source / test / review / merge | PASS for source, test, build and merge; no exact-merge review record found | `source/` |
| 2 | Installed artifact and local Relay/Agent start/restart | PASS | `installed/` |
| 3 | Desktop 1440x960 real Chrome and WebUI user journey | PASS for desktop, five views, SSE and settings read-only; full journey reused from `b7236b2` with a tree boundary | `browser/`, `reused/webui-journey-acceptance-RESULT.md` |
| 4 | Mobile 390x844 viewport vs physical cellular device | PASS for viewport only; physical cellular `unavailable` | `browser/mobile-390x844.png` |
| 5 | Direct transport: LAN local WSS vs public N3/STUN/NAT | local/LAN WSS source-level evidence reused; public N3/STUN/NAT `unavailable` | `docs/architecture/verification-map.json`, `docs/evidence/acp-l9-command-side-20261013/`, `docs/evidence/acp-d05-network-20261010/` |
| 6 | Dual-NAT public Relay Work | `unavailable` (post-MVP) | `docs/architecture/verification-map.json`, `docs/development-governance.md` |
| 7 | Provider config single-source read-only UI, live RCC 4444 turns, bounded retry | PASS (same-tree `0bb9c97` evidence; `0bb9c97` tree equals `6d7dcf9` tree) | `reused/webui-provider-closure-corrected-0bb9c97-RESULT.md`, `reused/config-readonly-ui-installed-0bb9c97-RESULT.md`, `browser/` |
| 8 | Console-offline Agent Work | PASS | `installed/installed-runtime-smoke.receipt.json` |

`matrix.json` is the machine-readable owner of the full per-item fields:
`entrypoint_command`, `verdict`, `first_missing_or_failing_node`, `raw_error`,
`evidence_path`, `prerequisite_owner`, and `next_executable_task`.

## Browser facts

The browser producer reused the staged final package, installed it outside the
source tree, started the registry, one real `--serve opencode` Agent daemon and
the control daemon from the installed CLI, then drove real Chrome with its own
temporary `--user-data-dir` and a short `/tmp` socket root. Every listener was
loopback. This proves the installed Console origin and the live DOM. It does
not prove a LAN peer, a public endpoint, or a mobile device.

- Desktop: real PNG `1440x960`, 43,578 bytes, `innerWidth=1440`,
  `innerHeight=960`, `scrollWidth=1440`, overflow 0.
- Mobile: real PNG `780x1688` (DPR 2), CSS viewport `390x844`,
  `innerWidth=390`, `scrollWidth=390`, overflow 0.
- Five views switched in the live DOM: discovery, networking, interaction,
  history, groups.
- The groups view is an explicit loading shell
  (`access=ready`, `isLoading=true`, text `正在加载群组…`). The control daemon
  composes no group endpoint, so its `/api/v1/group-request` calls returned
  400. No live group workspace is claimed. Group messaging is a separate later
  increment.
- A driver-owned EventSource received a real snapshot with `seq=1` and
  `agents=["reasoner-a"]`.
- The page's own `/api/v1/projection` fetch returned 200. The page received
  `/console-entry.js` plus 25 `/ui/` modules; all 25 byte-match the installed
  package.
- The Settings drawer carries `data-config-readonly=true`, has 0 buttons inside
  `.teams-drawer-body`, and has no `.teams-config-form`, `.teams-model-row` or
  `.teams-provider-actions`. The same-tree installed black box separately
  proves the populated read-only projection (10/10 checks).
- The page raised 0 uncaught exceptions. The only failed requests were the
  expected `/favicon.ico` 404 and the groups-view `/api/v1/group-request` 400s.

## Reused evidence and tree boundaries

- `0bb9c97` provider closure (32/32 PASS) and installed read-only config
  (10/10 PASS) were produced on tree `f22bf13a`, which is the same tree as
  `6d7dcf9`. The real RCC endpoint was `http://127.0.0.1:4444/v1`; the bounded
  retry sequence was 429, 429, 200 for the main prompt while the title request
  returned 200 without consuming a retry; a 401 was terminal with no replay.
- The full WebUI journey (95/95 and 37/37 PASS) was produced on `b7236b2`, not
  on `6d7dcf9`. The product delta from `b7236b2` to `6d7dcf9` is limited to the
  read-only Console config surface: `ui/teams-console/src/client/locale.ts`,
  `ui/teams-console/src/components/render.ts`,
  `ui/teams-console/src/state/controller.ts`, their tests, and two architecture
  maps. The same-tree installed read-only evidence covers that changed surface.
  This matrix therefore reuses the journey as supporting evidence with an
  explicit tree boundary, not as an exact-tree replay of every journey step.
- The prior `c5e5d4f` acceptance at `b7236b2` is kept for context only. Its
  browser and installed receipts are superseded by the `6d7dcf9` runs in this
  directory.

## Review and merge boundary

`6d7dcf9` is the current `origin/main` and a merge commit whose parents are
`b7236b2` and `0bb9c97`. The merge and the source/test/build gates are
verified. No independent overall review record for the exact `6d7dcf9` merge
commit was found in the accessible worker-run evidence. The same-tree
installed black box (10/10) and the full 1714-test run cover the changed
surface. This record does not claim a review PASS for the merge commit.

## Unavailable post-MVP items

These items are not failures. They are `unavailable` because their declared
gates are post-MVP and the required external environments are absent. No
loopback, health, mock or historical public claim substitutes for them.

| Item | Declared gate | Gate state | Missing prerequisite |
| --- | --- | --- | --- |
| Public direct transport / N3 / STUN / NAT | `teams-peer-work-execution-public-nat` | `design`, `required=false`, `phase=post-mvp` | deployed public endpoint and real NAT egress |
| Public Relay deployment | `teams-relay-process-deployment-public` | `design`, `required=false`, `phase=post-mvp` | packaged public Relay installation and public entrypoint receipt |
| Dual-NAT Work through public Relay | `teams-peer-work-execution-public-nat` plus the public Relay deployment gate | `design`, `required=false`, `phase=post-mvp` | two independent NAT hosts and a proven public Relay |
| Physical cellular mobile device | no local gate can prove it; `teams-static-ui-replay` remains `partial` | viewport evidence only | real phone, cellular path, authorized device |

The project compatibility boundary in `AGENTS.md` and the Phase 1 local network
scope in `docs/development-governance.md` defer public Relay, real NAT/STUN,
direct internet transport and mobile entrypoints. The local installed Relay
smoke and the loopback Chrome run do not upgrade those gates.

## Cleanup

All owned processes were stopped with explicit PIDs. No `pkill`, `killall`,
`kill $(...)`, `xargs kill` or `tmux kill-server` was used. The l13-test Console
PID 24441 and registry PID 87339 were pre-existing and were not touched.
`cleanup.json` records every started PID and the `kill -0` result. All owned
PIDs are dead. The owned `/tmp/at-p1-work` and `/tmp/at-p1-browser` roots were
removed after the evidence was copied here.

## Bug comments

Comments were added to `c5e5d4f`, `8ea5f7c` and `3c437d7` with the evidence
summary, the path to this directory, and the unavailable boundaries. No bug
was closed. The final comment receipts are in `bug-comments.json`.
