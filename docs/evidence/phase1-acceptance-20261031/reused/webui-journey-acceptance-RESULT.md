# RESULT — WebUI full user-journey black-box acceptance

Status: COMPLETE for the journeys below. Ten journey surfaces were exercised on the current
main. Nine pass with real evidence. One (provider config apply/readback) is reused from the c5
receipt because it was already proven on the same commit. Two items carry an explicit honest
boundary: the history list loads and its pagination control is correct, but no second page was
produced; and the groups page renders the unavailable state reliably, but its live workspace was
not reached from the supported single-daemon config.

- Base/head: `b7236b2a4dad0308e2769011d71effc0c0bad543` (`origin/main`, read only).
- Run date: 2026-10-29 (America/Los_Angeles).
- Output root: `/Volumes/Intel/playground/agentteams/.worker-runs/webui-journey-acceptance-20261029/`.
- Source tree was not modified. `git status --porcelain` was empty after the run.
- No product worktree was created. Evidence lives only under this output directory.

## How the evidence was produced

Two real producers ran. Both used a real installed candidate (pack + install outside the source
tree), a real control daemon, a real OpenCode-backed agent daemon, and real Google Chrome via CDP,
each under an isolated temporary HOME.

1. e562 producer: `docs/evidence/e562a05-webui-session-loop/black-box-session-loop.mjs`, run as
   `E562_EXTRA_PATHS=1`. Result 95/95 checks passed. Receipt `evidence/e562-extra.receipt.json`.
2. Gap producer: `evidence/webui-journey-gaps.mjs` (new, minimal, added only the four uncovered
   surfaces). Result 37/37 checks passed. Receipt `evidence/gap.receipt.json`.

Provider source. The e562 and gap producers bind the model to a deterministic local
OpenAI-compatible stub. These journeys create no reasoning turn except the permission flow, which
is deterministic by design. No external goaichat host was contacted. Real-model turns through the
required RCC 4444 endpoint are separately proven by the reused c5 BB10 receipt (see journey 7).

## Journey matrix

| # | Journey | Verdict | First failing node | Raw error |
| - | --- | --- | --- | --- |
| 1 | Discovery | PASS | none | none |
| 2 | Discovery details view | PASS | none | none |
| 3 | Create session | PASS | none | none |
| 4 | Message send | PASS | none | none |
| 5 | Permission allow-once (plus reject, always) | PASS | none | none |
| 6 | Final reply | PASS | none | none |
| 7 | Provider config apply + readback (RCC 4444) | PASS (reused c5) | none | none |
| 8 | Restart (control + agent daemon persistence) | PASS | none | none |
| 9 | History load + pagination control | PASS (load); page-flip not exercised | none | none |
| 10 | Groups unavailable render | PASS; live workspace not reached | none | none |
| 11 | Mobile 390x844 tap targets + drawer focus | PASS (WCAG 24px); 41px height note | none | none |

### 1. Discovery — PASS

Entry: real Chrome loads the shipped Console at the control origin; the observed agent renders as
a discovery card. Desktop view has no horizontal overflow.

Evidence: `evidence/e562-extra.receipt.json` (browser console load), `evidence/gap.receipt.json`
(`discovery`), screenshot `evidence/gap-mobile-discovery.png`.

### 2. Discovery details view — PASS

Entry: click the agent Details action. A role=dialog drawer opens. It shows the agent label
heading, an intro line `host-gap-agent · 在线 · 1 能力`, the Create session action, and the
declared-services section. Opening moves focus to the drawer header. Closing restores focus to
the Details trigger.

Evidence: `evidence/gap.receipt.json` (`discoveryDetails`, `detailsFocusRestore`), screenshot
`evidence/gap-discovery-details-desktop.png`.

Boundary: the declared-services section shows the honest hint `已声明服务…服务与资源明细不可用`
because this agent declares no detailed capability resources. The section renders as designed.

### 3. Create session — PASS

Entry: control `session.create` intent, and the browser create-session action through the agent
drawer. The agent executes `session/new` and publishes the new session id in the projection.

Evidence: `evidence/e562-extra.receipt.json` (control `session.create`, browser creates a session).

### 4. Message send — PASS

Entry: control `POST /api/v1/session-message` and the live browser composer. The `{ text }` body is
accepted and the user text plus tool event appear in the projection and the live timeline.

Evidence: `evidence/e562-extra.receipt.json` (message send and timeline events; browser sends
message and renders timeline).

### 5. Permission allow-once (plus reject, always) — PASS

Entry: a real pending permission carries the engine option set `once, always, reject`. The live
Allow once button is clicked. Separate turns click Reject (decision reject, denied tool not
completed) and Allow always (decision always, real /etc/hosts tool completes).

Evidence: `evidence/e562-extra.receipt.json` (approval completes the turn; reject path; always
path), screenshot `evidence/e562-desktop-pending-permission.png`.

Boundary: permission turns run against the deterministic local stub, as allowed by the task.

### 6. Final reply — PASS

Entry: after the permission reply the assistant final text is projected, the final event is
`completed`, and the completed tool carries real /etc/hosts text. The live timeline shows the
assistant response and removes the resolved permission buttons.

Evidence: `evidence/e562-extra.receipt.json` (browser approves and completes; the `/etc/hosts`
tool text `localhost`).

### 7. Provider config apply + readback (RCC 4444) — PASS (reused)

Entry: reused from the c5 run on the same head. BB08 shows config.toml as the single source with
revision/generation transitions and typed stale-generation errors. BB10 shows two real provider
turns through `http://127.0.0.1:4444/v1`, explicit primary/backup selection, restart with a
stable accepted revision, and readback `applyState=clean`.

Evidence: `/Volumes/Intel/playground/agentteams/.worker-runs/c5e5d4f-acceptance-20261029/evidence/provider/bb08-bb10.receipt.json`.

Boundary: the provider instance id/label `goaichat` is misleading; its effective base URL is the
local RCC 4444 endpoint. Every c5 BB10 turn used 4444. No external host was contacted.

### 8. Restart (control + agent daemon persistence) — PASS

Entry: control stop/start, then agent daemon converge-restart on the same config and port.
Control moved from pid 3415 to 8167 and retained all created sessions. Agent moved from pid 3470
to 8393 and its OpenCode child from 3493 to 8460. A post-restart session turn completed
end-to-end (`finalState=completed`).

Evidence: `evidence/e562-extra.receipt.json` (`controlRestart`, `agentRestart`).

### 9. History load + pagination control — PASS (load), page-flip not exercised

Entry: click the History tab. The page renders the work-record section and the connection-history
toolbar. With no Work records, the work section shows `当前连接未提供 Work 记录。`. The connection
history loads with count `0`, and the prev control is disabled with a consistent `data-enabled=false`.

Evidence: `evidence/gap.receipt.json` (`history`), screenshot `evidence/gap-history-desktop.png`.

First failing node: none. Honest boundary: this run produced fewer than the 20-record page limit,
so the prev control is correctly disabled and a real second-page flip did not occur. The
pagination control renders and its state matches its data marker. A multi-page flip needs a run
with more than 20 connection-history records.

### 10. Groups unavailable render — PASS; live workspace not reached

Entry: click the Groups tab. The page renders an explicit unavailable state: access
`not-configured`, phase `failed`, error panel with code `GROUP_ENDPOINT_NOT_CONFIGURED`, a Chinese
message that the control has no group entry, and a retry control. This is stable, including after
the agent daemon is stopped and the console reloaded.

Evidence: `evidence/gap.receipt.json` (`groups`, `groupsUnavailable`), screenshots
`evidence/gap-groups-desktop.png`, `evidence/gap-groups-unavailable-desktop.png`.

First failing node: none for the unavailable branch. Honest boundary: the live/available group
workspace (group list, issue panel, composer) was not reached. The agent config used here composes
no `[registration]` group channel and publishes no local group endpoint. Group messaging is a
separate later increment and needs group registration plus the hub (and Vikunja for issue state).
No mock or fabricated workspace was substituted.

### 11. Mobile 390x844 tap targets + drawer focus — PASS (WCAG 24px), 41px height note

Entry: 390x844 device metrics. Discovery has no horizontal overflow. Measured tap targets:
Details 56x41, Discovery tab 54x45, Groups tab 54x45, History tab 54x45, drawer close 56x41. All
meet the WCAG 2.5.8 minimum of 24px. Opening the agent drawer moves focus to the drawer header.
Closing restores focus to the Details trigger, on desktop and on mobile. The drawer has no
horizontal overflow at 390px.

Evidence: `evidence/gap.receipt.json` (`mobileTapTargets`, `mobileDrawer`, `mobileFocusRestore`),
screenshots `evidence/gap-mobile-discovery.png`, `evidence/gap-mobile-drawer.png`,
`evidence/e562-mobile-pending-permission.png`, `evidence/e562-mobile-pending-permission-discovery.png`.

Boundary: the Details and drawer-close buttons are 41px tall, below the Apple 44pt guideline but
above the 24px WCAG minimum. This matches the earlier mobile UX findings and is a presentation
note, not a journey failure. Mobile is viewport emulation only, not a real cellular device.

## Environment and process facts

- Chrome: `/Applications/Google Chrome.app` (headless, own throw-away profile per run).
- OpenCode: `/Users/fanzhang/.opencode/bin/opencode`.
- Reasoning provider binding: local deterministic OpenAI-compatible stub for e562/gap journeys.
  Real-model turns via RCC 4444 are proven by the reused c5 BB10 receipt.
- The two daemons, their OpenCode children, and each Chrome were reclaimed by explicit PID.
- Pre-existing other-owner processes were not touched: the `atckC6dk` stack (started 2026-10-25)
  and the `l13-test` registry/control (pids 87339, 90163).

## Cleanup

See `cleanup.json` for the full PID list and `kill -0` verification. All owned PIDs are gone. All
owned temporary roots (`gap-blackbox-*`, `e562-blackbox-*`) are removed. The evidence directory is
kept.

## Summary

On current main b7236b2, the real user journeys of discovery, discovery details, create session,
message send, permission allow-once/reject/always, final reply, control+agent restart persistence,
history load with a correct pagination control, and mobile tap targets plus drawer focus all pass
with real installed artifacts and real Chrome. Groups renders its unavailable state correctly but
its live workspace is unavailable in this config, and the history page was not flipped to a
second page because the run produced fewer than 20 records.
