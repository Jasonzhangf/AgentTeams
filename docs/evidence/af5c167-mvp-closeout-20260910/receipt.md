# AgentTeams relay-first MVP goal receipt

- delivery unit: MVP goal scope closeout and governance alignment
- candidate base: `309053dd38638b23ab94044f5736cf66388da505`
- candidate commit: `34e5496bc0adbc32cf79507c305471403c042d80`
- candidate review: independent Codex task `agentteams-mvp-closeout-r9-20260910`, PASS, no findings
- integration worktree: `playground/af5c167-mvp-integration-20260910`
- integration commit: `ebfc53194f61967f9f0a70b43dcb9fd737c946e6`
- integration review: independent Codex task `agentteams-mvp-integration-r10-20260910`, PASS, no findings
- remote push receipt: `git ls-remote origin refs/heads/main` returned `ebfc53194f61967f9f0a70b43dcb9fd737c946e6`
- owner: Desktop primary integration owner

## Verification

- candidate and integration `git diff --check`: passed
- `pnpm install --frozen-lockfile`: passed
- `pnpm verify`: passed, 71 test files / 413 tests, typecheck, Guidance compile,
  AppSDK compile, packaged Console/runtime smoke and AppSDK verify
- `appsdk compile`: passed
- `appsdk verify`: passed, `stage=contract_bound`
- public Relay, NAT, provider live, Console-offline Work and second-environment daemon
  replay remain
  required MVP evidence gates; this documentation delivery does not claim them complete.

## Scope

The goal now has one relay-first MVP profile: public Relay, at least one real NAT
egress, two daemon login/discovery/capability/resource/Work flow, passive fixed-root
`file-search`, allocation/idempotency/generation checks, explicit RCC and
`goaichat-openai` provider configuration, and Console-offline continuation/readback.
Direct, STUN/ICE, NAT-to-NAT direct, Endpoint E1/E2, relation governance, mobile replay,
full UI polish and provider failover remain post-MVP. The user-selected independent
Codex review route is recorded; AGY Review is excluded from this goal.

## Cleanup and memory

- candidate worktree `playground/af5c167-mvp-closeout-20260910` removed after review
  evidence was archived; branch `codex/af5c167-mvp-closeout-20260910` deleted
- integration worktree `playground/af5c167-mvp-integration-20260910` removed after
  integration review evidence was archived; branch
  `codex/af5c167-mvp-integration-20260910` deleted
- no project service, daemon, relay, listener or temporary process was started by this
  governance delivery
- project-memory entry `agentteams-mvp-goal-relay-first-20260910` is Level 2,
  `project-memory verify` passed, and tags include `ai-reviewed,human-unreviewed`
- review evidence is archived under `docs/evidence/af5c167-mvp-closeout-20260910/review/`
- cleanup receipt: `docs/evidence/af5c167-mvp-closeout-20260910/cleanup.md`
