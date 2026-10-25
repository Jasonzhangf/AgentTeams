# Whole-product user-path verification

Date: 2026-10-24 (America/Los_Angeles)
Candidate: delivered `origin/main` at f759ecc, installed from the staged npm tarball.
Environment: isolated `HOME=/tmp/uv-run/home`, npm prefix `/tmp/uv-run/prefix`; no production daemons were changed.

## Acceptance boundary and result

Alice (Chief Designer and acceptance officer) reviewed this report and the same worktree source. Her decision is NEEDS-FIX: the CLI Work path is limitedly accepted, but Console/ACP whole-product usability is not approved. This does not expand or invalidate the prior modular-monorepo structural delivery.

The installed CLI Work MVP is genuinely executable end to end. The whole product is not yet ready for a normal user to complete a Console/ACP workflow because the default Console path is opaque 502, Work results are absent from the UI, and local Console History is unavailable. No data loss, security incident, or whole-service outage was observed. The two core workflow blockers below are therefore P1, not P0.

This report separates source/build/package, installed lifecycle, real Work execution, WebUI browser replay, and unresolved product gaps. A passing build or package smoke is not treated as proof of a working user task.

## Completed real-user CLI path

1. `pnpm install --frozen-lockfile`: PASS.
2. `pnpm build`: PASS.
3. `pnpm smoke:installed`: PASS. The staged package was packed and installed into the isolated prefix; the installed `agentteams` CLI and runtime assets were used for the replay.
4. `agentteams` with no arguments printed command discovery help and exited successfully.
5. `agentteams init` created the user-owned `~/.agentteams/config.toml` and `internal.toml`. The generated config is readable, uses placeholders, and says it is the normal edit surface.
6. `agentteams start` started the local relay and generated provider/receiver daemons. `agentteams status` reported both endpoints online and their capability state.
7. Real business inputs in the isolated search directory were:
   - `a.txt`: `alpha content one`
   - `b.txt`: `beta content two`
   - `c.txt`: `gamma content three` (added for the archived replay)
8. Submit 1 completed with `requestState=succeeded`, `workClosure=closed`, and business result `./a.txt: alpha content one`. IDs: work `5e2a85a4-a2aa-49ea-8b9f-4d4cfb0830e8`, request `59e9a81f-3416-441b-bbf9-52d3fe92eb20`.
9. Submit 2 completed with `requestState=succeeded`, `workClosure=closed`, and business result `./b.txt: beta content two`. IDs: work `796bb3c1-cc1a-40a3-ace0-ae3a1e744c6f`, request `047ce385-2aca-4343-ad58-78770a4ebcd3`.
10. Archived replay submit 3 completed with `requestState=succeeded`, `workClosure=closed`, and result `./c.txt: gamma content three`. Raw response: `work-3-submit.json`; query response: `work-3-query.json`; command/exit transcript: `cli-trace-submit.txt`.
11. `agentteams work query` read back submit 3 with `observed=true`, `requestState=succeeded`, and the gamma result.
12. `agentteams stop` and a subsequent start were replayed. The generated config and lifecycle state remained usable across restart.

The archived raw CLI record does not contain credentials. The first two raw stdout streams were printed during the original replay but not saved byte-for-byte; their work/request IDs and business results are preserved above. The third submit and query are archived byte-for-byte.

## ACP/registry/control/WebUI replay

- A local registry was started with an isolated TLS certificate and placeholder admission credentials.
- A DSH agent was started through the installed quick-start entry (`agentteams --serve dsh --config ...`) with a real RCC provider binding (`http://127.0.0.1:4444/v1`, model `gonode.deepseek-v4-pro`). Readiness reported `registration=online`, `modelVerification=session/new`, and an actual engine process.
- A control daemon with discovery was started on an isolated port. Authenticated `GET /api/v1/projection` returned a real `reasoner-a` directory agent and live presence. Authenticated `GET /api/v1/events` returned live SSE snapshots.
- Chromium opened the control WebUI with HTTP Basic Auth. HTTP 200, `/console-entry.js` HTTP 200, no browser console errors on the discovery page, and the UI displayed the discovered `reasoner-a` agent. The language toggle switched Chinese to English.
- DSH `session/new` readiness and online registration prove startup, session initialization, and registration only. They do not prove real model inference, ACP task execution, or a multi-agent session; no such claim is made.
- The control UI connect action was accepted (`{"acceptedRevision":1}`) but remained disconnected because peer-side admission/connection configuration was incomplete. Legal refusal is not itself a defect, and admission must not be weakened. The user-facing fixes are preflight operability checks, clear accepted-versus-connected semantics, refusal explanation, and a recovery entry.

## Installed local Console replay

- Enabling Console requires `username`, `passwordEnv`, and policy permission. With the generated default policies (`allowedManagers=[]`), the Console served HTML but `/api/v1/projection` returned HTTP 502 `Console owner request failed; outcome not inferred`.
- After an explicit isolated test-only policy change to `allowedManagers=["__console"]` for the two generated agents, restart, and `agentteams console start`, the Console became online at its reported URL. Authenticated page access returned 200, and authenticated projection returned provider/receiver online plus the real Work records from the CLI submissions.
- The generated config does not explain this required manager admission. A normal user who only enables Console receives an opaque 502 instead of an actionable configuration error. This is a P1 core workflow blocker, not a P0 outage.
- The local Console History tab returned HTTP 503 `history owner is not bound to this control daemon`, even though the projection contained the real Work records. `console-host/src/http-api.ts` has the explicit `HISTORY_UNAVAILABLE` branch. The UI render/model has no Work-row rendering. Work history and ACP Session history must remain separate sources; they must not be hard-wired together as a shortcut.

## Browser-confirmed UX and behavior findings

P1 — Whole-product task visibility is incomplete. The CLI Work path executes real work, but the shipped Console UI does not render `projection.works`. Discover lists agents; Interaction is empty; History is 503 on the local Console. A user cannot see the result of a task they just submitted from the product UI. This is a core workflow blocker, with no observed data loss, security incident, or whole-service outage.

P1 — Default Console enablement is not user-completable. With the generated policy, the page loads but projection fails with HTTP 502. The error does not say that `allowedManagers=["__console"]` is required, which file to edit, or that a restart is needed. This is a core workflow blocker, with no observed data loss, security incident, or whole-service outage.

P1 — Discovery and operation are not aligned. A discovered agent can be visible while connection is forbidden or disconnected. The control UI showed a real discovered agent; connect returned raw `FORBIDDEN: agentId reasoner-a is not declared by this control daemon's accepted peers` when the peer declaration was absent. With a peer declaration, the request was accepted but remained disconnected because the peer-side admission was incomplete. The refusal is legal; the UX needs preflight checks, state semantics, reason, and recovery guidance.

P1 — Error rendering replaces the page with raw protocol text. Example: `FORBIDDEN: agentId reasoner-a is not declared by this control daemon's accepted peers`. There is no friendly explanation, corrective action, retry context, or preserved navigation.

P1 — The local Console History tab exposes a raw 503 and no recovery state. It is confusing because the API projection already contains Work rows. Work result presentation and ACP Session history remain separate follow-up owners.

P1 — The control status strip exposes raw enum tokens without labels: `unknown`, `disconnected`, `not-applicable`, `idle`. The control identity is shown as `unknown`, although the daemon has a configured identity.

P1 — Projection updates rebuild the UI more often than intended. `runtime/control-process.ts:963-968` does have JSON.stringify-based deduplication. The root cause is earlier: `runtime/control-process.ts:907` creates a new `observedAt` timestamp for each membership projection. The archived `sse-frames-control-7392.txt` contains consecutive raw frames; their only projection difference is `projection.connections[0].status.observedAt`, plus the expected outer `seq`. The business projection is unchanged, but serialized content differs, so the dedupe cannot suppress the frame. Browser interaction separately showed detached DOM elements during this update pattern. No battery or energy conclusion is made from this evidence.

P2 — Layout is not adapted to a normal desktop viewport: a narrow centered card leaves large unused margins and a small left-aligned content list.

P2 — Labels are concatenated. Examples include `Local provider (provider)runtime · file-search` and `Local provider · masterLocal provider · peer`. Agent identity, kind, and relation need visible separators and hierarchy.

P2 — The drawer backdrop intercepts page-level controls while a drawer is open. The drawer's own body Close works, but the full-viewport backdrop also covers the header controls and there is no visible modal dimming or clear indication that the underlying page is intentionally inert. This is a modal affordance problem, not a claim that Escape is unimplemented.

P2 — Interaction has no first-use guidance when no session is available. History also lacks a clear next action when unavailable.

Escape correction: `ui/teams-console/src/mount.ts:57-67` has a document Escape handler. A focused diagnostic confirmed that keyboard Escape closes the drawer (drawer count 1→0) and a second Escape closes the console. The earlier observation that Escape failed counted `.teams-overlay`, which remains after only the drawer closes; it was a measurement error. No Escape defect is reported.

## Archived evidence

- `cli-trace-submit.txt`: commands, exit codes, IDs and result summaries.
- `work-2-submit-raw.json`, `work-3-submit.json`, `work-3-query.json`: redacted/no-secret JSON responses.
- `sse-frames-control-7392.txt`: raw authenticated SSE frames used for the observedAt diff.
- `shots/`: browser screenshots for discovery, tabs, drawer, connection, language, and Console states.
- The original generated config and isolated data remain under `/tmp/uv-run` only until cleanup is complete.

## Acceptance and next work

Alice's acceptance decision is NEEDS-FIX. The limited CLI Work path is accepted as evidence; Console/ACP whole-product usability is not approved. Follow-up batches are:

1. Console default admission diagnostics and visible real Work results, with separate Work and ACP Session history owners.
2. Connection preflight, accepted-versus-connected state, refusal explanation, and recovery entry without weakening admission.
3. Projection update stability and focus/modal behavior, using the exact observedAt diff and browser interaction evidence.
4. Layout and label hierarchy.

No scope-expanding implementation was started during this verification. All findings are evidence for the corresponding owners.

## Retained test resources

All daemons and `/tmp/uv-run` resources are test-only. They must be stopped and removed after this evidence is archived. The production/main tree and shared/other-peer resources were not modified.
