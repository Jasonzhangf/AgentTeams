# D07 WebUI delivery evidence — 2026-10-11

Unit: D07 WebUI. Base `0296c93` (`origin/main`). Worktree
`/Volumes/Intel/playground/agentteams/acp-d07-webui-20261011`, branch
`codex/acp-d07-webui-20261011`.

## What this unit delivers

`ui/teams-console` binds the four pages (discovery, networking, interaction, history)
to the real owner projection. The UI reads only `control-protocol/console-api.ts`
Console DTOs plus authenticated `GET /api/v1/projection`, `GET /api/v1/history` and
`GET /api/v1/events`. It never mutates a frozen DTO: the additive ports are declared as
a UI-owned interface (`TeamsConsoleClientV1`) with the owner types imported from
`control-protocol/teams-state.ts` (`HistoryQuery`, `HistoryPage`,
`ConsoleProjectionSnapshot`, `ConsoleProjectionSink`, `ConsoleProjectionSubscriber`).
There is no second history source, no second connection port, and the UI never infers
online or execution state from history.

## Verification

All of the following ran on this candidate and passed:

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm build` | exit 0 |
| D07 UI gate (16 spec files) | 71/71 tests |
| D07 black box `black-box-webui.mjs` | 15/15 checks |
| D06 regression gate (6 files) | 115/115 tests |
| D05 regression gate (9 files) | 73/73 tests |

The corrected D07 gate command is the explicit 16-file path list recorded in
`docs/architecture/verification-map.json`; the earlier glob form silently selected zero
files and was replaced.

## Frozen DOM marker contract

Proven by `ui/teams-console/tests/render-d07.spec.ts`, which transpiles the real page
modules to a classic script and renders them with `renderConsole` inside real headless
Chrome, asserting only DOM the modules built — never source text. It covers
`data-team-page`, `data-team-page-view`, `data-team-band`, `data-band-state`,
`data-team-observation`, `data-team-cancel`, `data-permission-option`,
`data-permission-kind`, `data-permission-options-unavailable`, `data-team-refused`,
`data-team-error-code`, `data-team-draft`, `data-team-accepted`, `data-team-role-draft`,
`data-team-role-accepted`, `data-history-prev`, `data-history-count`,
`data-history-record` and `data-history-refused`, plus three negative cases: an engine
permission event that offered no options gets no fabricated button, observation loss
degrades the band to `stale`, and the notification surface is checked separately with a
six-case matrix.

The notification matrix matters because the frozen notification DTO carries no choice set,
so the row must look the option set up on the matching owner event instead of assuming
once/always/reject. The same pending permission notification is rendered against six engine
projections, and each of the five no-choice projections must yield **zero** approval
buttons **and** the `data-permission-options-unavailable` hint:

| engine projection for the matching event | expected |
| --- | --- |
| pending, no `options` field | 0 buttons + hint |
| pending, `options: []` | 0 buttons + hint |
| `state: 'resolved'` but still carrying the engine's old option list | 0 buttons + hint |
| no matching event at all | 0 buttons + hint |
| notification DTO omits `permissionId` | 0 buttons + hint |
| pending with the engine's real option set (control) | exactly 3 buttons, kinds once/always/reject |

The resolved case deliberately keeps a stale option list, because a resolved event that has
no options cannot discriminate the pending-state guard. Red-checked: dropping the
pending-state guard on the event lookup makes `data-resolved-event-no-approval` fail, so the
case really does cover the resolved state.

## Browser evidence boundary (deliberate non-claim)

This unit does **not** claim live-browser DOM evidence, and the reason is a real
platform boundary rather than a convenience:

1. Headless Chrome cannot satisfy the console's HTTP Basic challenge and cannot attach an
   `Authorization` header to a same-origin `fetch` or `EventSource`.
2. A credentialed origin URL is rejected by `fetch` itself with
   `Request cannot be constructed from a URL that includes credentials`.
3. The owner serves no credentials endpoint, so no alternative login path exists.
4. Chrome `--screenshot` against an unauthenticated origin writes no file and still exits
   0, so a captured image would be a blank error page and any PASS line would be false.

Consequently `black-box-webui.mjs` asserts the served `/ui/` module graph carries the D07
markers, the anonymous `401 Basic` challenge, and the real HTTP contract; it does not
dump a live authenticated DOM and does not capture a screenshot. An earlier version of
this driver both dumped a live DOM it could never populate and reported a screenshot it
never produced; both were removed rather than retained as misleading evidence.

## Honest refusals retained

- `connection.connect` and `network.membership.apply` return typed
  `UNSUPPORTED_OPERATION` — the frozen read port declares no network command channel.
  Discovery to connect and master/peer membership apply therefore cannot complete in this
  unit.
- `permission.reply` returns typed `UNSUPPORTED_OPERATION` because the control daemon binds
  no Session owner. A `permission.reply` payload carrying a field outside the frozen
  `ConsoleCommandV1` vocabulary (`callbackId`) is refused by the closed parser with HTTP
  400 instead of being forwarded to any engine.
- `GET /api/v1/history?kind=request` is refused by the owner. Over the real HTTP surface the
  observed answer is a bare **502** whose body carries the owner message and **no typed
  code**: the D06-owned history route in `console-host/src/http-api.ts` preserves an owner
  code only for owner *absence* (503) and drops a non-absence owner failure. The black box
  therefore asserts exactly that boundary — status 502 and `code` absent — instead of
  claiming a typed code. The UI renders the refusal from the response message, and the
  typed-code rendering path is proven only at unit level with a fixture, not over HTTP.

## Gate status

`teams-acp-d07-webui` stays **partial**: no installed-copy replay, no restart, no
deployed-entrypoint replay, no cross-device receipt, no live registry composition through
the serve entry, no mobile claim.
