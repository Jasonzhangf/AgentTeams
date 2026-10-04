# U2 recovery live blackbox run notes (776fcad)

Task: finish the real startup-recovery blackbox + provenance for the frozen U2
candidate already applied in this worktree. No product code edits.

Identity at start (read from tool output / env, not memory):

- worktree: /Volumes/Intel/playground/agentteams/u2-recovery-live-20261004
- branch: codex/u2-recovery-live-20261004
- base commit: 2f6caaa90db9f2592dcfc54c51984080650da0a4
- compiled artifact under test: generated/runtime-lib (parent-copied, exact
  tested candidate output; composition receipt
  $HOME/.codex/task-evidence/agentteams/u2-recovery-live-20261004-composition.json)
- opencode: $HOME/.opencode/bin/opencode 1.18.23 (reported 1.18.23)

Reused unchanged author evidence (not rerun unless a bound input changes):
focused35 PASS, regression28 PASS, typecheck0, runtimebuild0, graphvalidate0,
canonical SDK verify development-ready, compile0.

## Node log

### node: start

- conclusion: entering work; read required sources only (AGENTS.md,
  development-governance validation boundary, teams-local-config-v3 startup/
  reconcile, agent-process.ts public startup, managed-config-owner.ts,
  local-config persistence exports, existing live/owner specs, composition
  receipt).
- evidence: composition receipt lists 16 byte-equal product files and the
  pending items (map conflicts, actual blackbox, review, integration).
- next: resolve the two named map conflicts at U2 rows, then write and run the
  real consumer harness.

### node: map-conflict-resolution

- conclusion: resolved both named map conflicts, keeping latest-main U4 rows
  byte-unchanged and adding the U2 semantic rows.
- evidence: `node -e JSON.parse` OK for docs/architecture/function-map.json and
  docs/architecture/mainline-call-map.json; no conflict markers remain; diff vs
  base shows only the U2 rows changed.
- next: build and run the real consumer harness.

### node: real-blackbox-harness

- conclusion: wrote docs/evidence/776fcad-u2-recovery-live-20261004/
  real-consumer.mjs (compiled public startAgentProcess + real OpenCode serve +
  typed TOML persistence + real Relay console ingress).
- evidence: first run surfaced two harness bugs (profilePrefix must be
  teams-, inverted isListening probe, unhandled handle.closed rejection in the
  retained-uncertainty case); each was fixed in the harness only. No product
  edit.
- next: run to green and record raw log.

### node: real-blackbox-run

- conclusion: all three required cases pass.
- evidence: docs/evidence/776fcad-u2-recovery-live-20261004/real-consumer.log
  -> `RESULT {"ok":true,"assertions":27}` SUMMARY total=27 pass=27 fail=0.
  case1 dead-fence restart clean readback + real new OpenCode + Console
  projection clean; case2 live fence retained + ingress CONFLICT + no second
  substrate; case3 multi-fence partial clear + identity-mismatch rejection with
  unchanged bytes + final clean.
- next: provenance + cleanup record, stage allowed paths, report final tree.

### node: provenance-and-cleanup

- conclusion: recorded identities, map composition and cleanup in provenance.md;
  no owned runtime resource remains.
- evidence: no `u2-recovery-live` processes and no /tmp/u2-recovery-live-*
  directories after the run; harness log shows every owned PID confirmed exited.
- next: hand back to parent (no commit/push/review here).
