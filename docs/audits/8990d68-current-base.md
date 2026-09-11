# Audit: 8990d68 Endpoint discovery and protocol admission

Worktree: `playground/8990d68-endpoint-discovery-20260911`
Branch: `codex/8990d68-endpoint-discovery-20260911`
Base: `origin/main@964efa0abf00a388fd8cb624a41bfb3f6cdb9a39`
Owner: Endpoint discovery/admission protocol and server projection
Mode: read-only audit when production implementation already exists

## Bug source

`appsdk bug show 8990d68 --json` failed with
`GIT_BUG_SHOW_FAILED:Error: open /Volumes/extension/code/AgentTeams/.git/git-bug/lock: operation not permitted`.
Read the git-bug record directly from
`refs/bugs/8990d689d8e850602c3c0c02a8c91bae56e3873111ce93a444a5abc41c1178d6`.

The initial bug op is `[E2 P1] Endpoint discovery and protocol admission`.
Acceptance requires typed Endpoint references, scope-filtered discovery summaries,
Endpoint/Capability/Operation/Work reference validation with explicit errors,
rejection of URL/transport Endpoint values, and no business payload/metadata control
state.

## Current implementation check

- `control-protocol/endpoint-ref.ts` defines and parses typed
  `EndpointDiscoveryView`, `EndpointReference`, and `WorkEndpointReference`.
- Parsers reject unknown payload/metadata fields and URL/transport Endpoint
  identity values with `INVALID_INPUT`.
- `filterVisibleEndpoints` projects only same-scope views and hides disabled
  consumer views.
- `admitEndpointReference` validates provider ownership, scope, lifecycle
  visibility, and revision with explicit `NOT_FOUND`, `FORBIDDEN`, or
  `REVISION_CONFLICT` errors.
- `admitWorkEndpointReference` adds capability/version/operation admission on top
  of the Endpoint reference checks.
- `server/endpoint-discovery.ts` compiles legacy Agent capabilities into Endpoint
  views through `compileLegacyAgentCapabilities` and projects scope-filtered
  peer Endpoints with `projectPeerEndpoints`.
- `server/relay.ts` builds Endpoint views from the current published declaration,
  projects `relay.directory` and `relay.changed` through `projectPeerEndpoints`,
  and validates `relay.connect.targetAgentId` with `assertEndpointIdentity` so
  relay connect remains Agent identity based, not Endpoint URL based.
- `server/relay.spec.ts` includes committed `relay.connect` rejection cases for
  URL/transport target values (`https://...`, `wss://...`) with `INVALID_INPUT`,
  while normal Agent-id connects remain covered.

The architecture maps already bind this implementation:

- `function-map.json` -> `endpoint_discovery_admission`
- `resource-map.json` -> `endpoint-discovery-view` (with `peer-connection-assistance`
  retained as a distinct resource)
- `verification-map.json` -> `teams-endpoint-discovery-binding`

## Commands and results

`appsdk bug show 8990d68 --json`

- Result: FAIL, sandbox/permission was denied for the git-bug lock.
- Fallback: direct git-bug ref read, as described above.

Focused Vitest for non-network discovery/admission tests:

```text
/Volumes/extension/code/AgentTeams/node_modules/.bin/vitest run --config vitest.config.ts control-protocol/endpoint-ref.spec.ts server/endpoint-discovery.spec.ts control-protocol/relay-codec.spec.ts endpoint/registry.spec.ts

Test Files  4 passed (4)
Tests       20 passed (20)
```

Focused Vitest including the live Relay spec, historical attempt:

```text
server/relay.spec.ts: listen EPERM: operation not permitted 127.0.0.1
Test Files  1 failed | 4 passed (5)
```

This failure was recorded during the earlier audit run before the listener-capable
rerun below; it is retained as historical environment evidence and is not a
current result. The committed `server/relay.spec.ts` contains the required
URL-target `relay.connect` rejection coverage.

Current focused rerun at `2026-09-11T08:55:01-07:00`:

```text
/Volumes/extension/code/AgentTeams/node_modules/.bin/vitest run \
  --config vitest.config.ts \
  control-protocol/endpoint-ref.spec.ts \
  server/endpoint-discovery.spec.ts \
  control-protocol/relay-codec.spec.ts \
  endpoint/registry.spec.ts \
  server/relay.spec.ts

Test Files  5 passed (5)
Tests       38 passed (38)
```

The standalone `server/relay.spec.ts` rerun also passed 18/18. This proves the
current focused source path in a listener-capable environment; it is still not
public Relay, NAT, deployment, or full-regression evidence.

`appsdk verify`

- Result: `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`.

`appsdk compile`

- Result: PASS (`source_implemented`), using a read-only reuse of the parent
  repository pnpm install for the missing workspace packages. The worktree itself
  could not perform `pnpm install` because registry access is blocked in this
  environment (`ENOTFOUND registry.npmjs.org`).

`pnpm typecheck`

- Result: PASS (root tsc, opencode-adapter, console-host, and ui/teams-console).

`pnpm test` / `pnpm verify` full regression

- Not completed for this audit. Full regression includes real Chrome
  (`TEAMS_CONSOLE_REAL_DOM=1`) and packaged/runtime checks; this audit only
  reran the mapped focused source path. No full-regression PASS is inferred.

`git diff --check`

- Result: clean; re-run after creating this audit file.

## Endpoint-to-Work evidence boundary

The later Endpoint-to-Work issue is a separate admission edge that must be
checked before this audit can conclude that no production change is needed.
Current `origin/main@964efa0` contains that edge:

- `agent/work-resource.ts` calls `admitWorkEndpointReference` from provider
  admission and keeps the bound capability/operation fixed for requests.
- `runtime/agent-work-client.ts` selects a visible Endpoint revision from the
  Relay directory and carries its typed reference into the Work proposal.
- `control-protocol/work-wire.ts` carries Endpoint control state separately
  from the Work business payload.

This confirms that the historical Endpoint-to-Work callsite gap is already
covered by the existing mainline implementation; it is not a reason to add a
second Endpoint admission path in this audit.

The mapped `teams-endpoint-discovery-binding` command currently runs
`control-protocol/endpoint-ref.spec.ts`, `server/endpoint-discovery.spec.ts`,
and `control-protocol/relay-codec.spec.ts`, but does not run
`server/relay.spec.ts`, even though its checks mention Agent-identity
`relay.connect` rejection. The current focused rerun above passed the Relay
spec, but the mapped command still omits it; this remains a verification-map
evidence gap and must not be treated as a live public Relay acceptance result.

## Residual advisory

`assertEndpointIdentity` rejects explicit URL/scheme forms such as `wss://`,
`https://`, and any `://` value. A bare `host:port` authority is currently
accepted as an opaque identity token and would fail later during peer lookup with
an explicit `FORBIDDEN`, not a silent fallback. This matches the previously
recorded review P2 advisory and is not required by the mapped gate; no code change
was made for it in this read-only audit.

## Conclusion

The current `origin/main@964efa0` candidate already implements the in-scope
Endpoint discovery/admission protocol and server projection for 8990d68. The
Endpoint-to-Work call edge is also present in mainline, so no production code
change is justified by this audit. The evidence has a retained governance
limitation: the mapped discovery gate omits the live Relay spec. The current
listener-capable focused run passed, while full regression and public/NAT
acceptance remain outside this audit; the map omission remains with its owner.

No mainline push, merge, or bug close was performed.

## Delivery state

The candidate commit `docs(8990d68): audit endpoint discovery admission base` could
not be created in this sandbox. `git add` and `git commit` failed with
`fatal: Unable to create
'/Volumes/extension/code/AgentTeams/.git/worktrees/8990d68-endpoint-discovery-20260911/index.lock':
Operation not permitted`, because the shared worktree git directory is outside
the writable sandbox roots. This audit file therefore remains an untracked
worktree artifact; no push, merge, or bug close was performed.
