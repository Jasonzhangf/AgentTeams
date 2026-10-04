# Provenance and cleanup (776fcad U2 recovery live blackbox)

## Frozen inputs (identity read from tool output / env)

- worktree: /Volumes/Intel/playground/agentteams/u2-recovery-live-20261004
- branch: codex/u2-recovery-live-20261004
- base commit (latest main): 2f6caaa90db9f2592dcfc54c51984080650da0a4
- composition receipt:
  $HOME/.codex/task-evidence/agentteams/u2-recovery-live-20261004-composition.json
  (16 byte-equal product files from the stopped predecessor; product code
  untouched by this task)
- compiled artifact under test: generated/runtime-lib (parent-copied exact
  tested candidate output; the harness imports only this compiled public entry)
- node: v22.22.2
- opencode: $HOME/.opencode/bin/opencode 1.18.23 (reported 1.18.23)
- AppSDK: $HOME/.cargo/bin/appsdk 0.1.0010
  SHA84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a

## Map conflict resolution (U2 rows only; U4 preserved byte-unchanged)

Both files had genuine latest-main composition conflicts. Resolution keeps the
latest-main U4 rows verbatim and adds the U2 rows:

- docs/architecture/function-map.json: U4 `work_graph_execution` row kept
  byte-unchanged; U2 `cli_user_facade` row (initializeLocalConfig +
  776fcad-u2-config-impl-20261003 continuation evidence) added.
- docs/architecture/mainline-call-map.json: U4 `work-query-user-entry-v1`,
  `work-open-user-entry-v1`, `work-request-user-entry-v1`,
  `work-close-user-entry-v1` rows kept byte-unchanged; U2
  `cli-user-entry-v1` row (init -> initializeLocalConfig) added.

Both parse as JSON with no conflict markers. Other changed rows in these files
(`provider-config-v1`, `local-supervisor-v1`, `managed_config_application`,
`daemon_console_config_dispatch`, ...) are the frozen U2 candidate's own
semantic rows carried with the applied candidate, not edits made here.

## Real blackbox harness

- docs/evidence/776fcad-u2-recovery-live-20261004/real-consumer.mjs
- raw run: docs/evidence/776fcad-u2-recovery-live-20261004/real-consumer.log
- result: `RESULT {"ok":true,"assertions":27}`, SUMMARY total=27 pass=27 fail=0

Coverage: real isolated temp config.toml/internal.toml/HOME/ports; real
OpenCode serve; compiled public `startAgentProcess`; real Relay console ingress;
typed TOML config persistence and public owner persistence API.

1. case1-dead-fence-restart: durable fence naming a positively-owned real old
   OpenCode pid; old substrate stopped and exit confirmed; compiled daemon entry
   restart applies a real new OpenCode, readback clean
   (acceptedRevision==effectiveRevision==2, applyState clean), no remaining
   fence and no stale lastApplyError; public Console projection clean; new
   substrate stopped with the daemon.
2. case2-live-fence-blocked: still-live old substrate; daemon registers with the
   explicit obligation retained (applyState uncertain), config ingress returns
   CONFLICT, exact fence retained, no second substrate launched, uncertain never
   cleared; only owned resources stopped.
3. case3-multi-fence-identity: two durable fences plus a stale lastApplyError;
   removing one retains the other and the error; same operationId with
   mismatched full identity is rejected CONFLICT with internal.toml bytes/state
   unchanged; last clear yields clean with no stale error.

## Cleanup

- harness finally: stops all started daemon handles, spawned OpenCode
  substrates, the consumer Relay client and Relay server; removes its temp
  directories.
- observed after run: no `u2-recovery-live` processes remain; no
  /tmp/u2-recovery-live-* directories remain; all case PIDs recorded in the log
  are confirmed exited (`owned old substrate confirmed exited`).

## Not claimed

- No Session/model execution completion is claimed (none needed).
- No commit, push, review, or product-source edit performed (parent owns
  integration).
