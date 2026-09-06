# Managed OpenCode daemon evidence

Candidate source: `codex/managed-runtime-20260906` based on `origin/main@2912004`.

## Proven

- `runtime/agent-process.ts` accepts an optional strict `openCode` process and
  durable config section. It assembles the existing typed RuntimeConfigStore,
  OpenAI model catalog client, managed child owner, and Console config binding.
- `runtime/agent-process.spec.ts` starts a second Node Agent child over the
  local TLS Relay, sends `config.apply` through the remote Console client, and
  reads `acceptedRevision=3` and `effectiveRevision=3` after a stub OpenCode
  `/global/health` and authenticated `/config` readback.
- `runtime/managed-opencode-session.spec.ts` starts installed OpenCode 1.18.23
  and completes a real `/session` and `/session/{id}/message` request against a
  local OpenAI-compatible provider stub. The stub emits a terminated SSE stream
  because OpenCode sends `stream:true`.
- The AgentBrowser icon is loaded by the UI for agents declaring `browser` and
  is copied by the packaging smoke. The canonical source remains
  `ui/teams-console/assets/agentbrowser-icon.jpg`.

## Commands

```text
pnpm test                         # 59 files, 312 tests
pnpm typecheck                    # passed
pnpm build                        # passed
appsdk guide compile              # passed, advisory enforcement
appsdk compile                    # passed, source_implemented
pnpm smoke                        # packaged Console/runtime smoke passed
appsdk verify                     # {"ok":true,"stage":"contract_bound"}
```

## Limits

This evidence does not prove live RCC 4444 or goaichat inference/tool/approval,
public NAT or relay fallback, direct Agent-to-Agent relations, real phone
replay, active crash recovery, or deployment installation outside the source
worktree. Those remain separate milestones.
