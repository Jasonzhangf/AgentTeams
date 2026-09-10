# 8ea5f7c N3-D3 runtime direct-route publication receipt

- Issue: `8ea5f7c`
- Delivery unit: N3-D3 runtime direct-route publication
- Base: `4fca75b1d6f2242a341d797ef3e5b037bd50dc8d`
- Worker candidate: `9e6499893359cd4a0a8056368d840b0c5913c8c2`
- Candidate tree: `515316ad79590712c3d715649922ae3af96aa82f`
- Integration commit before receipt: `41899201f88d35e12aafce246b28168a667e7352`

## Scope

The runtime now projects the Agent-owned direct listener's actual `wss` endpoint
and bound port into one typed `direct` route candidate before the existing Relay
publication call. Relay remains the owner of declaration revision, login
generation admission, identity checks, and directory readback. The route only
contains endpoint metadata and `authRequired`; the raw listener credential stays
in the local admission path.

Changed implementation paths are limited to:

- `runtime/agent-process.ts`
- `runtime/agent-process.spec.ts`

This receipt is delivery evidence and does not add another route owner.

## Review and verification

- Exact candidate review: PASS; candidate tree `515316ad79590712c3d715649922ae3af96aa82f`, no P0/P1 findings.
- Exact integration review: PASS; integration commit `41899201f88d35e12aafce246b28168a667e7352`, no findings.
- Focused runtime publication tests: 2 files / 9 tests passed.
- Full regression: `pnpm test`, 71 files / 407 tests passed.
- `pnpm typecheck`: passed.
- Guidance compile, AppSDK compile and AppSDK verify: passed; verify stage `contract_bound`.
- Packaged Console and runtime smoke: passed.
- `git diff --check`: passed.
- An unrelated readiness timing test failed once during the first full verify and passed on its direct rerun; the complete suite then passed. The failure was not on either changed path and no source fallback was added.

## Boundary

This delivery proves local runtime route publication and Relay directory
readback. It does not prove directory-discovered cross-daemon direct connection,
public direct reachability, NAT or dual-NAT traversal, Claw/coder2new replay,
device/mobile acceptance, production install/restart, or Console-offline Agent
Work. Issue `8ea5f7c` remains open for those later delivery units.

## Cleanup obligation

The candidate and integration worktrees remain owned until the remote main push,
memory update, and cleanup receipt are recorded.
