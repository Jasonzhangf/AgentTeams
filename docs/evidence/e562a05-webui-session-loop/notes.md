# e562a05 WebUI session-loop P0 evidence

Date: 2026-10-28

- Issue: `e562a05`
- Worktree: `/Volumes/Intel/playground/agentteams/webui-session-loop-p0`
- Branch: `codex/webui-session-loop-p0`
- Base: `4b6aa66` (`origin/main` at dispatch)
- Evidence boundary: source-tree candidate only. No installed-copy replay,
  restart receipt, deployed-entrypoint replay, cross-device receipt or mobile
  claim is made.

## Delivered behavior

- `session.create` is a durable Session intent with no invented Session id.
  `session.open` validates the requested Session against the target peer's
  published observation.
- The agent daemon executes `session/new` on its managed readiness channel,
  drains that channel, and publishes the new Session through
  `session-observation.json`.
- A single-key `{ text }` payload becomes ACP text Content Blocks; an existing
  array payload passes through unchanged.
- `AcpHost` projects ordered user and assistant text, tool state, pending and
  resolved permissions with real options, and completed or failed final events.
- Control projection exposes `sessionEvents` and marks observed live peers as
  `kind: 'runtime'` with `sessionCapable: true`.
- The T4 UI received one integration fix: its API client accepts the control
  daemon's closed `{ acceptedRevision }` create receipt. The existing T4
  interaction behavior was verified, not rewritten.

## Verification

1. `pnpm exec vitest run --no-file-parallelism` over the eight affected config,
   host, publisher, watch, control, projection and serve specs:
   `146 passed / 8 files`, exit `0`.
   Log: `focused-tests-final.log`.
2. `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --no-file-parallelism` over
   the fourteen D07 UI specs: `73 passed / 14 files`, exit `0`.
   Log: `d07-ui-gate-final.log`.
3. `pnpm typecheck`: exit `0`.
4. `pnpm build`: exit `0`.
5. `git diff --check`: exit `0`. `jq empty` over all five
   `docs/architecture/*.json` maps: exit `0`.

## Real-process black box

Command:

```sh
node docs/evidence/e562a05-webui-session-loop/black-box-session-loop.mjs
```

Result: `40/40` checks passed, exit `0`. The run used a real control daemon, a
real OpenCode-backed agent daemon and real Chrome. It proved:

1. Initial projection marks the managed agent runtime/sessionCapable and the
   Interaction composer and Send button are enabled.
2. Control accepts `session.create`; the agent executes `session/new` and
   publishes `ses_e7c039211ffe2mBMhVLjx1ZdsC`. `session.open` accepts that
   published Session.
3. A `{ text }` message reaches the engine and projects the user text and tool
   state. The browser creates `ses_e7c037c8bffeN4QcdDYAOzX3aV` and sends its
   message to that Session.
4. The pending permission exposes `once,always,reject`; the browser renders and
   clicks `Allow once`, the permission resolves, and the assistant final text
   and completed final event appear.

Evidence files:

- `black-box-final.log`
- `receipt.json`
- `browser-pending-permission.png`
- `black-box-session-loop.mjs`

## Residual risks and unverified boundaries

- This is source-tree evidence, not an installed-copy or deployed-entrypoint
  replay.
- Restart, cross-device and mobile behavior were not verified.
- A hard crash without a graceful observation write can leave the last
  observation staleness visible.
- The notification row keeps a fixed Console title; the Session event carries
  the engine title.
- The daemon's readiness-channel Session can still appear in observations.
- Full `pnpm verify` and AppSDK compile/verify were not run for this worker
  candidate.

## r2 Review-fix round (e562a05 P1-1a, P1-1b, P1-2)

Changes: per-Session `activePrompts` admission in `agent-host/acp-host.ts`; out-of-order
`permission.reply`/`session.cancel` behind a blocked head-of-line `session.message` in
`runtime/acp-serve.ts`; strict ACP `ToolCallContent` projection with `engine.protocol-fault` on
unsupported or missing content. The black-box driver gained Session A/B interleaving and a
`localhost` assertion on the completed `/etc/hosts` tool event.

Verified on the current tree: focused `agent-host` + `runtime` intent-watch suites 51/51 pass
(exit 0), `tsc --noEmit` exit 0, `pnpm build` exit 0. UI sources unchanged, so the r1 D07 UI
gate evidence is reused.

Not verified: the real black-box run and the commit. The sandbox disables loopback listeners
(`listen EPERM`, `CODEX_SANDBOX_NETWORK_DISABLED=1`) and denies writes to the worktree gitdir
(`index.lock: Operation not permitted`); an escalated retry was refused by policy. Receipt
`receipt.json` is removed; the r1 receipt stays as `receipt-r1-passing.json` history only.

Evidence: `focused-tests-r2.log`, `typecheck-r2.log`, `build-r2.log`, `black-box-r2-blocked.log`,
`commit-r2-blocked.log`.

Red-first check for the r2 fixes: restoring the HEAD versions of `agent-host/acp-host.ts` and
`runtime/acp-serve.ts` made 6 tests fail (the five new cases plus the ordered-projection test that
now uses the real nested content shape). The fixed files were restored byte-identically (cmp) and
the suites pass 51/51 again. Log: `red-tests-r2.log`. The per-Session test also asserts that each
Session's own text update and response land on that Session and that both admit a new prompt once
their response arrives.
