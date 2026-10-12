# D08 live-browser DOM evidence — 2026-10-11

## Scope

This artifact closes the A07 live-browser DOM evidence boundary. It starts the real control
daemon through the worktree CLI, serves the real WebUI entry, drives real Chrome through CDP,
injects HTTP Basic authentication at the Network layer, navigates to a clean origin URL, reads
the live DOM, observes the page's own authenticated projection fetch **and its own SSE
subscription**, receives a real SSE snapshot frame in the real page context, compares the page
response with an independent HTTP read, and captures a PNG screenshot.

Producing this evidence found three real defects in the shipped Console/WebUI path. They are
fixed in this unit, and each is now a real `PASS` check instead of an unverified `GAP` claim.

The control daemon configuration still declares no `[discovery]` and binds no Console/Session
owner. The projection is therefore a real but empty snapshot. This evidence does **not** claim
real-event-driven animation, discovery rows, permission interaction or Session interaction.

## Defects this producer found

| # | Defect | Evidence | Fix |
|---|--------|----------|-----|
| 1 | The origin emitted `event: projection`, but both UI clients subscribe with `addEventListener('snapshot', ...)`. A named SSE event that matches no listener is dropped silently, so the live view never applied a snapshot. | `console-host/src/http-api.ts:79` vs `ui/teams-console/src/client/live-client.ts:89` and `observation.ts:97` | Server now emits `snapshot`. The name is pinned on both sides: `console-host/tests/http-api.spec.ts` and `runtime/control-process.spec.ts`. |
| 2 | Nothing in the product called `controller.startObservation()`, so the shipped page never opened `/api/v1/events` at all. | `startObservation()` defined at `ui/teams-console/src/client/controller.ts:169`; no caller in `console-entry.js`, `mountTeamsConsole`, or any test | `mountTeamsConsole` starts observation and its teardown now calls `controller.destroy()`. |
| 3 | The history view had no initial read, and its only trigger is the "previous" control, which is disabled until a page has already been read. The view could never show a record. | `ui/teams-console/src/client/render.ts:1052` (only `loadHistory` caller) and the disabled expression at `:1053` | `selectPage('history')` and a persisted initial history page now start the first read. |

Defects 1 and 3 were previously reported as `GAP` lines whose text asserted facts the producer
never measured. Defect 2 was real, but the `GAP` text was hardcoded, so it kept printing the
same claim after the behaviour changed. All three are now asserted.

## Producer integrity fix

`ensureBuilt()` used to reuse any existing build. That silently produced evidence for code that
was no longer on disk: the run that first showed `event: projection` was reading a stale
`generated/runtime-lib`, not the edited source. The producer now always runs `pnpm build`, so no
evidence in this directory can come from a stale artifact.

## Exact command

```bash
cd /Volumes/Intel/playground/agentteams/acp-d08-browser-20261011
node docs/evidence/acp-d08-browser-20261011/live-browser-dom.mjs
```

The producer always rebuilds, then starts a temporary control daemon and a temporary headless
Chrome profile under a producer-owned temp root. It removes that root on success.

## Canonical run output

```text
  -- running the project build so no evidence can come from a stale artifact: pnpm build
PASS control daemon — real control daemon via the worktree CLI: state=running pid=13699 listener=127.0.0.1:51477 url=http://127.0.0.1:51477
PASS origin challenge — anonymous GET / -> 401 challenge="Basic realm="AgentTeams", charset="UTF-8""
PASS chrome launch — real Chrome pid=13758 headless=new own --user-data-dir=chrome-profile devtools=ws://127.0.0.1:51492/devtools/browser/0f76f00c-9979-4565-a2f9-8267ebfd0781
  -- Network.setExtraHTTPHeaders installed the Basic credential at the network layer
PASS page load — clean origin URL (no userinfo) http://127.0.0.1:51477/ -> document 200 text/html; readyState=complete title="AgentTeams Console"
PASS page module graph — the real entry loaded 20 scripts, all 200: /console-entry.js + /ui/browser.js + 19 /ui/ modules
PASS page fetch — the page's own same-origin fetch('/api/v1/projection') -> 200 application/json, 88 bytes (observed on the Network domain)
PASS DOM markers — live DOM of the real entry: page names=discovery,networking,interaction,history view=discovery bands=registration,connection,engine,request states=unknown,disconnected,not-applicable,idle observation=live agentRows=0
PASS live page subscription — the shipped entry opened its own /api/v1/events (HTTP 200) and applied a real snapshot: data-team-observation=live
PASS four pages — real UI navigation rendered all four pages: discovery(rows=0,records=0,count=-) networking(rows=0,records=0,count=-) interaction(rows=0,records=0,count=-) history(rows=0,records=0,count=0)
PASS history readback from the page — the live history view read its own history (HTTP 200) and rendered data-history-count="0" with data-history-prev enabled="false"
PASS SSE frame — same-origin EventSource inside the live page received a real frame: seq=1 projectionVersion=1 (HTTP 200,200 on /api/v1/events)
PASS projection match — page-received bytes === independent HTTP read (88 bytes); SSE snapshot === independent read; DOM agent rows 0 === server agents 0
PASS page runtime errors — 0 uncaught page exceptions across the whole live session (189 CDP events observed)
PASS screenshot — real PNG written to /Volumes/Intel/playground/agentteams/acp-d08-browser-20261011/docs/evidence/acp-d08-browser-20261011/live-browser-dom.png (19874 bytes, 19874 bytes on disk)
GAP event-driven DOM markers — data-team-cancel, data-permission-option and data-history-record need a real Session, permission or history row. This control daemon binds no Console/Session owner and declares no [discovery], so /api/v1/projection is a real but empty snapshot ([] agents, 0 sessions, 0 notifications); those markers are NOT asserted and no event-driven animation is claimed
  -- cleanup: chrome pid 13758 alive=false (profile-matching processes=0); control pid 13699 alive=false
live-browser DOM PASS: 14 checks
gaps: 1
cleanup: removed owned root /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/d08-browser-nA1gJW
```

Exit code: `0`. The run was repeated and was stable.

## What the checks prove

- The project CLI starts the real control daemon, and that daemon owns the WebUI listener.
- An unauthenticated origin request receives the frozen Basic challenge.
- Chrome loads the real console HTML and 20 real script responses, including
  `/console-entry.js` and `/ui/browser.js`, all HTTP 200.
- The clean-origin page makes its own same-origin authenticated
  `fetch('/api/v1/projection')`, observed as a Network-domain `200 application/json`.
- The live DOM carries all four frozen page names, `data-team-page-view`, the four state-band
  markers and `data-team-observation`; real UI clicks render all four page views.
- **The shipped entry opens its own `/api/v1/events`** and applies a real snapshot: the
  observation state moves from `unknown` to `live`. This is the check that defect 1 and defect 2
  used to defeat.
- **The shipped history view reads its own history** (`/api/v1/history` HTTP 200) when it is
  opened. This is the check that defect 3 used to defeat.
- A same-origin EventSource created inside the real page context receives the server's real
  `event: snapshot` frame with `seq=1` and a v1 projection.
- The exact projection bytes received by the page equal the independent Node HTTP response; the
  SSE snapshot also equals that response; the DOM agent-row count equals the server agent count.
- 0 uncaught page exceptions across the whole live session.
- The screenshot is a valid PNG: 756x469, 19,874 bytes.

## What this does not prove

- It does not prove real-event-driven animation. The control daemon binds no Console/Session
  owner, so the projection is real but empty and there is no owner change to animate.
- It does not prove discovery rows, permission options, session cancellation, history records,
  or targeted interaction. No corresponding owner or data exists in this control-only run.
- It does not claim an installed-tarball result, a cross-device result, or a review result.

## Gates re-run for the fixes in this unit

| Gate | Command | Result |
|------|---------|--------|
| `teams-acp-d06-control` | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 6 files, **117 tests pass** |
| `teams-acp-d07-webui` | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism ui/teams-console/tests/{api,boundary,contract-compat,controller,drafts,focus-dom,live-client,locale,model,observation,page-discovery,page-networking,page-interaction,page-history,render,render-d07}.spec.ts` | 16 files, **71 tests pass** |
| typecheck | `pnpm typecheck` | exit 0 |
| build | `pnpm build` | exit 0 |

## Screenshot

[live-browser-dom.png](./live-browser-dom.png) — valid PNG, 756x469, 19,874 bytes.

## Process cleanup verification

After the canonical run, the exact check was:

```bash
cd /Volumes/Intel/playground/agentteams/acp-d08-browser-20261011
ps -axo pid=,command= | grep -E "d08-browser-|agentteams.mjs|control-process.js" | grep -v grep || true
```

It returned no lines. The producer's own cleanup line also reports both explicit pids dead and
zero profile-matching Chrome processes. Chrome always uses its own `--user-data-dir` inside the
owned temp root, so the user's separate Chrome profiles are never touched.
