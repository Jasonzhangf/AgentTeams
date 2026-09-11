# 5abd96e integration receipt

- Issue: `5abd96e` (`[Discovery] Managed OpenCode readiness error is timing-sensitive`), remains open pending remote delivery and cleanup.
- Candidate: `5cb8e38c8fb82c8ce91db49e22d9e6eccc0fa861`.
- Integration base: `da5661b4cad88c78832baebe32c09b80d17e3b24`.
- Integration candidate tree before this receipt: `da07e40`.
- Integration branch: `codex/integration-5abd96e-20260911`.

## Scope

Managed OpenCode keeps native spawn errors, waits one event-loop turn after the readiness deadline, and classifies an already-ended child using its actual exit state. The fixture uses a direct Node executable with an explicit exit code and adds a native missing-executable regression.

## Validation

- `vitest run runtime/managed-opencode.spec.ts` — 1 file / 3 tests passed.
- Candidate focused replay previously passed 15/15 across five three-run batches; the exact integration candidate was rerun above.
- `pnpm typecheck` — blocked before TypeScript checking because the integration worktree has no installed `tsdown`/workspace dependencies.
- `appsdk verify` — passed: `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`.
- `git diff --check` — passed.

## Boundaries

This receipt does not claim public Relay deployment, NAT egress, dual-daemon Work replay, provider apply/readback, Console-offline execution, or remote `main` push. Those gates remain open.
