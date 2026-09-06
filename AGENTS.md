# Teams Project Contract

## Project truth

- Teams is an independent multi-agent control plane. Agents may be passive
  capability services, including browser CLI agents. OpenCode is the execution
  substrate for LLM agents; Teams owns its UI and provider configuration.
- Console Host is an optional, non-permanent observation/configuration client.
  Agent Hosts communicate and coordinate independently after configuration.
  Each Agent Host adapts one local capability service/runtime; peer and
  master/slave relations do not depend on a live Console or grant authority
  without Agent-side policy.
- The server owns discovery, account and transport admission policy, and route
  publication. Network owns link configuration, transport, health, and route
  execution. Config owns versioned shared and per-agent provider/model config.
- Runtime composes network and daemon lifecycle. Agent code remains network,
  server, and config agnostic.
- Provider Agents declare capabilities/resources and own matching admission,
  work execution and resource allocation. Consumer/Host Agents request matches
  and work. Both roles support one-to-many; Console Host is not the consumer
  role. See `docs/design/teams-agent-relation-communication-v1.md`.
- Config owns LLM provider instances, model catalogs and per-agent bindings. Each
  daemon durably owns its accepted config revision; Console submits changes.
  OpenCode config is derived adapter output, not a second editable source.
  See `docs/design/teams-provider-config.md`.
- First release includes public networks, NAT and relay. Agent-to-Agent traffic
  can use direct or explicit relay transport; Console is never a required relay.
- Every daemon bootstraps from its configured relay-service address/identity:
  login, publish capability/resource declarations, discover peers, then connect.
  Relay service owns directory, scoped broadcast and connection assistance,
  including traversal/STUN and traffic relay when supported. Agent work policy
  and actual resource admission remain at the provider Agent.

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

- The user-selected long-running delivery contract is
  `docs/goals/teams-long-running-delivery.md`. Each stage closes only after
  applicable engineering evidence, evidence-reviewed memory Level 2 updates,
  and verified owned-resource cleanup or explicit retained obligations.
- Project memory has one writer: the primary integration owner. Workers submit
  stage notes and memory candidates; only official memory commands write or
  promote records, and promotion requires a real memory review reference.
- Development commands and evidence applicability are owned by
  `docs/development-governance.md`. AppSDK lifecycle module `teams-source` is
  the source/artifact admission unit; semantic ownership remains in the five
  `docs/architecture/` maps. SDK-owned `.appsdk/maps/` describe SDK governance.
- Use the root workspace and lockfile. Do not restore parent-repository paths,
  placeholder builds, or historical lifecycle evidence producers.
- Before implementation read the resource, function, mainline, module, and
  verification maps. Bind every change to one feature and one owner.
- Use one clean worktree below `playground/` for one semantic milestone.
  Keep main and other workers' dirty state untouched.
- Append exploration, hypothesis, first divergence, intervention, root cause,
  and verification evidence to the current run notes.
- Update maps and tests in the same change when ownership, paths, call edges, or
  gates change.

## Verification contract

- Run focused tests first, then the mapped regression suite, typecheck/build,
  AppSDK compile/verify, and required OpenCode install/restart/live replay.
- `pnpm verify` runs the local source/governance baseline. Current library
  artifacts have no service install/restart operations; deployment changes must
  bind their real operations and public-entrypoint evidence before validation.
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
