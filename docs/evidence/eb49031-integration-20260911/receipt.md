# eb49031 integration receipt

- Issue: `eb49031` (`[Discovery] Relay client timeout cancellation assertion flakes`), remains open pending remote delivery and cleanup.
- Candidate: `88246fc76daa5ff935b8b63217bb8e5d63bcdb5f`.
- Integration base: `964efa0abf00a388fd8cb624a41bfb3f6cdb9a39`.
- Integration tree before this receipt: `88246fc76daa5ff935b8b63217bb8e5d63bcdb5f`.
- Integration branch: `codex/integration-eb49031-20260911`.

## Scope

The relay client registers a pending request before the control write, starts the reply deadline only after the write resolves, and retains early replies by correlation. A reply timeout remains an explicit `RESULT_UNKNOWN`; no retry, fallback, or second control-state owner was added.

## Validation

- `vitest run control-protocol/relay-codec.spec.ts network/route-plan.spec.ts network/peer-route.spec.ts` — 3 files / 18 tests passed.
- `vitest run network/relay-client.spec.ts network/console-channel.spec.ts network/wss-connection.spec.ts` — blocked by the current execution environment: local TLS listeners do not complete; the relay-client suite timed out at its `createRelayServer({ host: '127.0.0.1', port: 0 })` startup and the WSS timeout case also timed out. This is retained as an environment/network-listener blocker, not converted to a product pass.
- `pnpm typecheck` — blocked before TypeScript checking because the integration worktree has no installed `tsdown`/workspace dependencies.
- `appsdk compile` — blocked by the same missing `tsdown` dependency (`MODULE_BUILD_FAILED:teams-source`).
- `appsdk verify` — passed: `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`.

## Boundaries

This receipt does not claim full relay lifecycle verification, public Relay deployment, NAT egress, dual-daemon Work replay, provider apply/readback, Console-offline execution, or remote `main` push. Those gates remain open.
