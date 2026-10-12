# D08 live-browser DOM evidence — 2026-10-11

## Scope

This artifact closes the A07 live-browser DOM evidence boundary. It starts the real control
daemon through the worktree CLI, serves the real WebUI entry, drives real Chrome through CDP,
injects HTTP Basic authentication at the Network layer, navigates to a clean origin URL, reads
the live DOM, observes the page's own authenticated projection fetch **and its own SSE
subscription**, receives a real SSE snapshot frame in the real page context, compares the page
response with an independent HTTP read, and captures a PNG screenshot.

Producing this evidence found three real defects in the shipped Console/WebUI path. They are
fixed in this unit, and each now has a real `PASS` check worded to claim only what it measures.

The control daemon configuration still declares no `[discovery]` and binds no Console/Session
owner. The projection is therefore a real but empty snapshot. This evidence does **not** claim
real-event-driven animation, discovery rows, permission interaction or Session interaction.

## Defects this producer found

| # | Defect | Evidence | Fix |
|---|--------|----------|-----|
| 1 | The origin emitted `event: projection`, but both UI clients subscribe with `addEventListener('snapshot', ...)`. A named SSE event that matches no listener is dropped silently, so the live view never applied a snapshot. | `console-host/src/http-api.ts:79` vs `ui/teams-console/src/client/live-client.ts:89` and `observation.ts:97` | The origin now emits `snapshot`. The name is pinned on both sides: `console-host/tests/http-api.spec.ts`, `runtime/control-process.spec.ts`, and the D06 PART1 black box. |
| 2 | Nothing in the product called `controller.startObservation()`, so the shipped page never opened `/api/v1/events` at all. | `startObservation()` defined at `ui/teams-console/src/client/controller.ts:169`; no caller in `console-entry.js`, `mountTeamsConsole`, or any test | `mountTeamsConsole` starts observation, and its teardown now calls `controller.destroy()`. |
| 3 | The history view had no initial read, and its only trigger is the "previous" control, which is disabled until a page has already been read. The view could never show a record. | `ui/teams-console/src/client/render.ts:1052` (only `loadHistory` caller) and the disabled expression at `:1053` | `selectPage('history')` and a persisted initial history page now start the first read, guarded on a live client. |

Why defect 1 was not caught earlier: `runtime/control-process.spec.ts` pinned `event:
projection` on the origin side and `ui/teams-console/tests/live-client.spec.ts` fed a synthetic
`snapshot` event on the client side, so each side's test agreed with itself and neither crossed
the real origin with the real client. The D06 PART1 black box did assert the event name, but it
asserted the origin's own string, so it could not detect that the client disagreed.

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
PASS control daemon — real control daemon via the worktree CLI: state=running pid=33298 listener=127.0.0.1:59330 url=http://127.0.0.1:59330
PASS origin challenge — anonymous GET / -> 401 challenge="Basic realm="AgentTeams", charset="UTF-8""
PASS chrome launch — real Chrome pid=33342 headless=new own --user-data-dir=chrome-profile devtools=ws://127.0.0.1:59350/devtools/browser/4704bdf8-9b0e-4221-938d-a1342f8ef1c5
  -- Network.setExtraHTTPHeaders installed the Basic credential at the network layer
PASS page load — clean origin URL (no userinfo) http://127.0.0.1:59330/ -> document 200 text/html; readyState=complete title="AgentTeams Console"
PASS page module graph — the real entry loaded 20 scripts, all 200: /console-entry.js + /ui/browser.js + 19 /ui/ modules
PASS page fetch — the page's own same-origin fetch('/api/v1/projection') -> 200 application/json, 88 bytes (observed on the Network domain)
PASS DOM markers — live DOM of the real entry: page names=discovery,networking,interaction,history view=discovery bands=registration,connection,engine,request states=unknown,disconnected,not-applicable,idle observation=live agentRows=0
PASS live page subscription — the shipped entry opened its own /api/v1/events (HTTP 200) and started its observation controller (data-team-observation=live); snapshot application by the shipped client is NOT claimed here
PASS four pages — real UI navigation rendered all four pages: discovery(rows=0,records=0,count=-) networking(rows=0,records=0,count=-) interaction(rows=0,records=0,count=-) history(rows=0,records=0,count=0)
PASS history readback from the page — the live history view read its own history (HTTP 200) and rendered data-history-count="0" with data-history-prev enabled="false"
PASS SSE frame — a same-origin EventSource inside the live page that subscribes to `snapshot` received a real frame: seq=1 projectionVersion=1 (HTTP 200,200 on /api/v1/events); this is the check that proves the origin's event name matches the client subscription, because it times out when the origin emits any other name
PASS projection match — page-received bytes === independent HTTP read (88 bytes); SSE snapshot === independent read; DOM agent rows 0 === server agents 0
PASS page runtime errors — 0 uncaught page exceptions across the whole live session (193 CDP events observed)
PASS screenshot — real PNG written to /Volumes/Intel/playground/agentteams/acp-d08-browser-20261011/docs/evidence/acp-d08-browser-20261011/live-browser-dom.png: 756x469, 19874 bytes (19874 bytes on disk)
GAP event-driven DOM markers — data-team-cancel, data-permission-option and data-history-record need a real Session, permission or history row. This control daemon binds no Console/Session owner and declares no [discovery], so /api/v1/projection is a real but empty snapshot ([] agents, 0 sessions, 0 notifications); those markers are NOT asserted and no event-driven animation is claimed
  -- cleanup: chrome pid 33342 alive=false (profile-matching processes=0); control pid 33298 alive=false
live-browser DOM PASS: 14 checks
gaps: 1
cleanup: removed owned root /var/folders/jm/blkk8bbd6v78rv2pwxgxh3kr0000gn/T/d08-browser-PaTCdL
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
- **The shipped entry opens its own `/api/v1/events`** and starts its observation controller.
  This is the check that defect 2 used to defeat.
- **The shipped history view reads its own history** (`/api/v1/history` HTTP 200) when it is
  opened. This is the check that defect 3 used to defeat.
- **A same-origin EventSource subscribing to `snapshot` receives a real frame** with `seq=1` and
  a v1 projection. This is the check that defect 1 used to defeat: it times out when the origin
  emits any other event name.
- The exact projection bytes received by the page equal the independent Node HTTP response; the
  SSE snapshot also equals that response; the DOM agent-row count equals the server agent count.
- 0 uncaught page exceptions across the whole live session.
- The screenshot is a valid PNG whose dimensions the producer reads from the IHDR chunk and
  asserts: 756x469, 19,874 bytes.

## What this does not prove

- It does not prove that the shipped client **applied** a snapshot.
  `ProjectionObservationController.start()` emits `live` before any snapshot arrives
  (`ui/teams-console/src/client/observation.ts:27-31`), so `data-team-observation=live` follows
  from the subscription starting. The page also renders from its own HTTP projection fetch.
  Snapshot application by the shipped client is not separately observable while the projection
  is empty.
- It does not prove real-event-driven animation. The control daemon binds no Console/Session
  owner, so the projection is real but empty and there is no owner change to animate.
- It does not prove discovery rows, permission options, session cancellation, history records,
  or targeted interaction. No corresponding owner or data exists in this control-only run.
- It does not claim an installed-tarball result, a cross-device result, or a review result.

## Gates re-run for the fixes in this unit

| Gate | Command | Result |
|------|---------|--------|
| `teams-acp-d06-control` | `pnpm exec vitest run --no-file-parallelism runtime/control-process.spec.ts agent-host/acp-host.spec.ts runtime/acp-serve.spec.ts cli/agentteams.spec.ts console-host/tests/http-api.spec.ts control-protocol/console-api.spec.ts` | 6 files, **117 tests pass** |
| `teams-acp-d07-webui` | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism ui/teams-console/tests/{api,boundary,contract-compat,controller,drafts,focus-dom,live-client,locale,model,observation,page-networking,render,render-d07}.spec.ts` | 13 files, **68 tests pass** |
| D06 PART 1 black box | `node docs/evidence/acp-d06-control-20261011/black-box-control.mjs` | **10 checks pass** (updated to the `snapshot` event name) |
| D06 PART 2 black box | `node docs/evidence/acp-d06-part2-20261011/black-box-control-part2.mjs` | **7 checks pass** |
| D06 permission optionId black box | `node docs/evidence/acp-d06-part2-20261011/black-box-permission-option.mjs` | **10 checks pass** |
| typecheck | `pnpm typecheck` | exit 0 |
| build | `pnpm build` | exit 0 |

## Review

An independent reviewer (fresh context, no author transcript) reviewed candidate `7735765` and
returned **FAIL** with one BLOCKING finding and eight others. All were addressed:

- **F1 BLOCKING** — the event-name change invalidated the declared D06 PART 1 black box, which
  asserted `event: projection`, while the maps and governance still claimed it passed 10/10. The
  driver now asserts `snapshot` and was re-run to 10/10; PART 2 and the permission driver were
  re-run green as well.
- **F2 HIGH** — this file and `verification.json` claimed the live-page-subscription check proved
  the shipped client applied a snapshot. It does not. Corrected here and in the producer.
- **F3 HIGH** — the claim that both black-box drivers read only the SSE data was false. Replaced
  with the real reason defect 1 was missed.
- **F4 MEDIUM** — the D07 gate note and two governance rows still asserted the old browser
  boundary. All three now record the corrected boundary.
- **F5 LOW** — `ensureHistoryLoaded` lacked the live-client guard its constructor path has.
- **F6 LOW** — the screenshot dimensions were restated rather than measured. The producer now
  reads and asserts them from the IHDR chunk.
- **F7 LOW** — `committed` was false inside a commit.
- **F8 ADVISORY** — a failed-run temp root was retained and unreported. Removed.
- **F9 ADVISORY** — no unit test covered the history fix. `controller.spec.ts` gained two tests:
  a live client reads history on open, a fixture client does not.

## Screenshot

[live-browser-dom.png](./live-browser-dom.png) — valid PNG, 756x469, 19,874 bytes. The producer
reads these dimensions from the IHDR chunk and asserts them.

## Process cleanup verification

After the canonical run, the exact check was:

```bash
cd /Volumes/Intel/playground/agentteams/acp-d08-browser-20261011
ps -axo pid=,command= | grep -E "d08-browser-|agentteams.mjs|control-process.js" | grep -v grep || true
```

It returned no lines. The producer's own cleanup line also reports both explicit pids dead and
zero profile-matching Chrome processes. Chrome always uses its own `--user-data-dir` inside the
owned temp root, so the user's separate Chrome profiles are never touched.
