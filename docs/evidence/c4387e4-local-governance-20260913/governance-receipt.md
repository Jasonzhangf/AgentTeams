# c4387e4 Local Network governance receipt

- Issue: `c4387e4`
- Base: `origin/main@1555ca4b05dd016a242bdba7fca1865f9459620c`
- Candidate: staged documentation-only tree; the exact tree is recorded in the
  exact-review and integration receipts after the final staging pass.
- Owner: Desktop primary task.
- Scope: active project contract, README, Local Network goal/design profiles,
  control-protocol manifest, and the resource/function/mainline/verification
  map bindings. No runtime, provider, UI, generated, dependency, or historical
  evidence source was changed.

## Governance result

- Phase 1 is explicitly the local network bridge: independent daemons,
  `~/.agentteams/config.toml`, real local sockets, discovery/broadcast/connect/
  negotiate, Agent Work, provider/OpenCode configuration, and UI projection.
- Public Relay, NAT/STUN, NAT-to-NAT, mobile, direct internet transport, and
  full UI polish are explicitly post-MVP.
- Console remains an observation/configuration surface and is excluded from the
  Agent-to-Agent data path.
- The old DSH wording was removed from active contract/design/profile text. The
  deferred adapter, tests, project memory, notes, and historical evidence were
  not rewritten or deleted.
- The architecture maps and protocol manifest now describe local bridge/socket
  bootstrap as the Phase 1 chain; public Relay/NAT route resources remain
  explicitly deferred.

## Verification

Commands were run from this clean owner worktree:

```text
pnpm install --frozen-lockfile
git diff --check
appsdk compile
appsdk verify
```

Receipts:

- `pnpm-install.log`
- `diff-check.log`
- `appsdk-compile.log`
- `appsdk-verify.log`
- `appsdk-compile-initial-failure.log` records the first missing-dependency
  divergence before the frozen install.

This receipt does not claim runtime, install, restart, or local socket delivery;
those belong to L1-L5 delivery units.
