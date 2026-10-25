# Review findings — af49f2e first delivery (2026-10-25)

Alice reviewed candidate `af49f2e` / base `be8b7da` and returned FAIL for the
8dde877 Console group WebUI first delivery. This file records the complete
review intent for the rework; Alice does not write files directly.

Related tasks:

- `task-8dde877-console-group-ui`
- `task-8dde877-console-group-api`

## R1 [P1] Real unknown write is read as refused and recovery identity is lost

- UI owner. Locations: `ui/teams-console/src/client/group-client.ts:134-139`,
  `state/group-workspace.ts:550`, `controller.ts:1213-1216`.
- Problem: HTTP 200 `{ok:false,error:{code:RESULT_UNKNOWN,...}}` is returned as
  refused by `requestGroup`; `applyRefusal` clears retryable/commits. Existing
  unknown tests mostly mock transport and bypass the real client. After a real
  `issue.create`/`submit` loses its receipt, the user loses the recovery entry
  and a retry can mint a second commit/issue/comment. A 502 or receipt timeout
  is not definite failure.
- Required fix: keep unknown separate from definite refusal through typed
  error/outcome; keep the original frame/commit and source context; do not infer
  state from error text. Counterexample must cross the real client/controller/
  HTTP: original write succeeded then receipt lost, page unknown, recover with
  the original commit read-only, external write count stays 1; ordinary
  FORBIDDEN stays refused. Necessary transport is Carol's.

## R2 [P1] action.submit does not bind result identity before side effects

- Backend owner. Locations: `server/group-hub.ts:897-925`,
  `action-registry.ts:101-110`.
- Problem: only completed/refused/cancelled are rejected; blocked/failed still
  writes a real comment before failing conversion. Unknown action has no
  persisted `resultCommitId`, so a different commit writes again, and two
  different commits can pass the precheck concurrently.
- Required fix: persist this action's original result commit ownership before
  any external write; make submit/only-recover/forbid states explicit; same
  commit plus same content returns the original result, different content
  conflicts, a different commit cannot bypass outstanding responsibility.
  Counterexamples: blocked/failed submit comment increment 0; after first
  unknown write a different commit is rejected with increment 0; original commit
  remains recoverable; concurrency does not produce a second result write.

## R3 [P1] action.create reads external state before authorization

- Backend owner. Locations: `server/group-hub.ts:856-878`; the action-create
  graph authorizes first.
- Problem: `readExternal`/`convergeSessionClosed`/`save` run before
  `canCommand`/`canRequest`. A non-member or edgeless actor with a sessionId can
  trigger a trusted daemon external read; when externally closed it also cancels
  the queue and persists before the later refusal or CONFLICT.
- Required fix: validate current membership, scope, target and command/request
  edge first, then read fresh state. Counterexamples: illegal actor / edgeless
  request external call count 0 and zero session/action/persistent changes.

## R4 [P1] A stale close still cancels actions created after reopen

- Backend owner. Locations: `server/group-hub.ts:833-844`.
- Problem: after `confirmIssueOperation` decides an old op is not applied,
  `direction=close` still unconditionally cancels session actions. A lost close
  receipt, then reopen, then new action N: recovering the old close gets
  conflict and, although the issue stays open, N is cancelled.
- Required fix: only a currently valid close settlement may dispose actions;
  expired/conflict/unknown old close must not modify later responsibility.
  Counterexample asserts open and N still pending with no new external write,
  not merely that the issue was not closed again.

## R5 [P1] External close convergence is not wired to real scheduling

- Backend owner. Locations: `docs/design/teams-group-messaging-v1.md:599-605`,
  `server/group-hub.ts` queryIssue/readExternal, `controller.ts:938-1000`.
- Problem: the existing timer only reads `group.list`; hub/runtime has no
  periodic issue-state read and queryIssue depends on explicit commands. After
  a user closes in Vikunja, idle sessions and pending actions can remain
  open/pending forever. A read before create only protects the next command.
- Required fix: attach a bounded periodic read and shared close settlement at
  the correct daemon/hub owner; Console must not be a required sync service.
  Counterexample: after external close, with no manual query and no create,
  actions cancel within the period; a read failure preserves unknown and
  responsibility; reopen does not re-run old actions.

## R6 [P1] Human first version cannot report pending blocked/failed

- UI owner. Locations: `ui/teams-console/src/components/page-groups.ts:434-458`.
- Problem: the blocked button is enabled only for accepted/in_progress, but a
  new human action is pending and the first version has no accept/start entry;
  there is also no failed report operation. Cards render only the creation-time
  `action.reason`, never `action.report` reason/evidence.
- Required fix: an owner's pending action can report blocked/failed, shown
  according to real permissions, and the report reason/evidence is visible after
  reporting and after refresh. Do not fake a start or revive an old action.

## R7 [P1] Asymmetric master/peer request and refusal chain is incomplete

- UI owner plus backend refusal persistence owner. Locations:
  `group-workspace.ts:677-682`, page-groups assignee/refuse controls,
  `server/group-hub.ts:1005-1011`.
- Problem: `assignableMembers` reads only current `actor.mastersOf`; a peer's
  `mastersOf` is usually empty, so the UI cannot request a master whose
  `mastersOf` contains this peer even though backend `canRequest` allows it. The
  master refusal branch does not save or return the requested refusal reason.
- Required fix: derive the target list from both directions of the same explicit
  edge; refuse only for an authorized master; a peer cannot refuse a valid
  assignment; refusal reason is non-empty, persisted and visible to the
  initiator after refresh, and must not overwrite the original `action.reason`.
  Counterexamples cross the real page/API: M→P assign, P→M request, M refuse
  with reason, edgeless refused, P cannot refuse.

## R8 [P1] New background group polling bypasses unified context switching

- UI owner. Locations: `controller.ts:1004-1013` `mergePolledGroups`.
- Problem: `applyReply(group.list)` may change `selectedGroupId`, but this path
  directly `updateGroup(next)` without `switchGroupContext`, so generation does
  not advance, new group content is not read, and an old write is not parked or
  a draft restored. A 4-second poll switching to g2 can still let a delayed g1
  read land in the new view.
- Required fix: a real selection change from polling or projection follows the
  same invariant; unchanged members and unchanged selected group must not
  rebuild the page. Counterexample: pending g1 read, poll removes g1 and selects
  g2, delayed g1 cannot overwrite g2; original write and draft are recoverable.

## A1 [non-blocking cleanup]

- Screenshots and the page-groups issue main area still print the internal
  sessionId directly. The existing design keeps internal ids diagnostic-only;
  remove that redundancy while keeping human-readable titles and necessary
  Vikunja references.
- `docs/architecture/group-webui-first-delivery.md` still places Review before
  Chrome and describes installed purpose / frontend in progress, which differs
  from current admission and source/candidate boundaries. Correct it with the
  documentation close. Verify affected edges/gates of the existing five owner
  maps against the original contract; do not add a sixth authority map.

## V1 [pending evidence]

- `vikunja-sync.ts` `preserveOnFullUpdate` keeps only title/description/id/
  project_id. This API is confirmed full update, but there is no real
  before/after for non-default priority/due-date, so full-field preservation
  cannot be claimed yet. Carol dispatches GCM to run a bounded probe on a
  dedicated test issue; if fields are lost, repair in the same owner without
  compensating by duplicate writes. Do not write the risk down as confirmed data
  corruption until reproduced.
