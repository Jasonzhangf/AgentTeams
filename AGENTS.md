# Teams Project Contract

## Project truth

- Teams is the OpenCode-first multi-agent control plane. DSH remains deferred.
- Master Console Host connects to independent Agent Hosts; an Agent Host adapts
  one local agent runtime to the Teams protocol.
- The server owns discovery, account admission, permission policy, and route
  publication. Network owns link configuration, transport, health, and route
  execution. Config owns versioned shared and per-agent provider/model config.
- Runtime composes network and daemon lifecycle. Agent code remains network,
  server, and config agnostic.

## Semantic invariants

- Preserve Session, message, tool, permission, and notification meaning.
- Unsupported or lossy protocol, parameter, or network mapping fails explicitly
  at the owning adapter boundary.
- Control state uses typed control frames/resources or the error chain only.
  Routing, auth, generation, health, retry, config, and diagnostics never enter
  Session business payload or metadata.
- One feature, resource, and implementation has one owner. No fallback, silent
  strip, guessed repair, or duplicate path.

## Development contract

- Before implementation read the resource, function, mainline, module, and
  verification maps. Bind every change to one feature and one owner.
- Use one clean worktree below `Teams/playground/` for one semantic milestone.
  Keep main and other workers' dirty state untouched.
- Append exploration, hypothesis, first divergence, intervention, root cause,
  and verification evidence to the current run notes.
- Update maps and tests in the same change when ownership, paths, call edges, or
  gates change.

## Verification contract

- Run focused tests first, then the mapped regression suite, typecheck/build,
  AppSDK compile/verify, and required OpenCode install/restart/live replay.
- Runtime changes require evidence from the user-observable entrypoint. Camo
  desktop and mobile replays are separate evidence; desktop layout is not mobile
  evidence.
- Review is allowed only after the exact candidate has passed validation. A
  review result never substitutes for tests, build, install, restart, or replay.

## Canonical surfaces

- Requirements and design: `docs/`
- Architecture maps: `docs/architecture/`
- AppSDK maps and contracts: `.appsdk/`
- Runtime source: `agent-host/`, `network/`, `server/`, `runtime/`,
  `control-protocol/`, `opencode-adapter/`, `console-host/`, `ui/`
- Deferred source: `dsh-adapter/`
