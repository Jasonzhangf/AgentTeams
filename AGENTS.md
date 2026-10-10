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
- Phase 1 uses a local network bridge. Agent-to-Agent traffic uses the explicit
  local socket path; Console is never a required relay or data path. Public
  Relay, NAT/STUN, direct internet transport and mobile entrypoints are later
  phases.
- Every daemon bootstraps from its configured local bridge/endpoint:
  register, publish capability/resource declarations, discover peers, negotiate,
  then connect. A later Relay service may own scoped directory, broadcast and
  connection assistance, but it does not own Agent Work policy or resource
  admission. Those remain at the provider Agent.
- Compatibility boundary: the Phase 1 local-network MVP is the supported scope.
  Public Relay, real NAT/STUN, direct internet transport, mobile entrypoints, the
  removed legacy host UI, and empty admission scaffolding are out of scope and
  are not restored. Each later phase binds its own gate. See
  `docs/development-governance.md`.

## Semantic invariants

- Preserve Session, message, tool, permission, and notification meaning.
- Unsupported or lossy protocol, parameter, or network mapping fails explicitly
  at the owning adapter boundary.
- Control state uses typed control frames/resources or the error chain only.
  Routing, auth, generation, health, retry, config, and diagnostics never enter
  Session business payload or metadata.
- One feature, resource, and implementation has one owner. No fallback, silent
  strip, guessed repair, or duplicate path.

## Ownership

- Declare one owner for each module, resource, mutable truth, and cross-module
  edge. Record allowed and forbidden paths at the narrowest stable boundary.
- Derived output never becomes a second source of truth. OpenCode config, the
  compiled library under `generated/`, and SDK-generated records are derived.
- Before adding behavior, check whether it is needed and already owned. Reuse a
  shared function for common semantics; keep separate implementations only for a
  necessary difference.
- A missing operator, hook, or gate fails or skips explicitly with a recorded
  reason. It never produces mock success.
- This project declares no fixed lifecycle skeleton; do not introduce one by
  default.

## Architecture truth

- Keep only the maps the project needs for ownership, affected boundaries, and
  verification. Do not duplicate the same fact across maps.
- Missing or ambiguous ownership blocks the affected change, not unrelated
  project work.
- The five `docs/architecture/` maps are the semantic owners. Update the
  affected map, tests, and declared gates in the same change when ownership,
  paths, call edges, or regression coverage change.

## Development contract

- The user-selected long-running delivery contract is
  `docs/goals/teams-long-running-delivery.md`. Each stage closes only after
  applicable engineering evidence, evidence-reviewed memory Level 2 updates,
  and verified owned-resource cleanup or explicit retained obligations.
- Project memory has one writer: the primary integration owner. Workers submit
  stage notes and memory candidates; only official memory commands write or
  promote records, and promotion requires a real memory review reference.
- The primary may review verified facts and promote them to memory Level 2.
  Tag such records `ai-reviewed` and `human-unreviewed`; neither another agent
  nor human approval is a prerequisite. Human review must never be implied.
- Development commands and evidence applicability are owned by
  `docs/development-governance.md`. AppSDK lifecycle module `teams-source` is
  the source/artifact admission unit; semantic ownership remains in the five
  `docs/architecture/` maps. SDK-owned `.appsdk/maps/` describe SDK governance.
- Use the root workspace and lockfile. Do not restore parent-repository paths,
  placeholder builds, or historical lifecycle evidence producers.
- Before implementation read the resource, function, mainline, module, and
  verification maps. Bind every change to one feature and one owner.
- Use one clean worktree below `/Volumes/Intel/playground/agentteams/<unit>` for
  one semantic milestone. Keep main and other workers' dirty state untouched.
- Append exploration, hypothesis, first divergence, intervention, root cause,
  and verification evidence to the current run notes.
- Treat the mainline checkout as read-only. Develop in one clean owner worktree
  created from the latest remote mainline, and preserve other workers' state.
- The project's commit and push protection is procedural: the primary integrates
  only after a passing candidate gate and one review. The project declares no
  commit-time or push-time hook, because a commit does not run the full gate. A
  merge, protection, or review result proves only its own boundary.
- Remove the owned worktree and release its claim only after required delivery,
  the remote receipt, and retention evidence exist.

## Process control

- AppSDK quality, safety, and evidence gates are mandatory when applicable.
  Guidance and project memory are auxiliary: no plan or memory write is required
  by default, and memory never overrides project AGENTS, Skills, or declared
  contracts.
- When Guidance is used, bind the plan to the current goal, task, module, owner,
  scope, declared rule sources, source commit, and tree. Execute declared
  transitions; an optional node uses its explicit bypass edge, never an
  undeclared jump. Append observations and evidence to the active step.
- Workflow close and lifecycle completion are separate results.
- Review blocks concrete quality, safety, contract, and material structural
  regressions. Optional simplification is advisory. Reuse valid evidence while
  its inputs are unchanged, and rerun affected checks on drift.
- Keep Collab automatic for multi-worker identity, communication, and task/file
  ownership. Its failure blocks dependent collaboration, not independent
  isolated work.
- Notes are not promoted automatically to memory, Skills, or rules.

## Verification contract

- Run focused tests first, then the mapped affected gates, typecheck/build,
  AppSDK compile/verify, and required OpenCode install/restart/live replay.
  Reuse valid evidence for unchanged mapped stages.
- `pnpm verify` runs the local source/governance baseline. The base package
  already has real installed lifecycle gates for its current scope: npm tarball
  install, installed CLI/Console entrypoints, and installed Relay plus two
  Agent start/restart. Deployment changes must bind their own real operations
  and public-entrypoint evidence before validation.
- Runtime changes require evidence from the user-observable entrypoint. Camo
  desktop and mobile replays are separate evidence; desktop layout is not mobile
  evidence.
- Review is allowed only after the exact candidate has passed validation. A
  review result never substitutes for tests, build, install, restart, or replay.

## Evidence boundary

- Report source, test, build, installed artifact, restart, deployed-entrypoint
  replay, review, merge, remote receipt, freeze, and cleanup separately. Never
  infer a later evidence level from an earlier one.
- A blocked result names the first failing gate, the preserved state, the retry
  policy, the owner, and one executable next action.

## Canonical surfaces

- Requirements and design: `docs/`
- Architecture maps: `docs/architecture/`
- AppSDK maps and contracts: `.appsdk/`
- Runtime source: `agent-host/`, `network/`, `server/`, `runtime/`,
  `control-protocol/`, `opencode-adapter/`, `console-host/`, `ui/`
- Project facts and boundaries: this file. Reusable project procedure:
  `docs/development-governance.md`. Machine workflow: the declared `.appsdk/`
  guidance contracts. The project declares no project-local Skill.
- Optional memory retrieval, level-3 writes, and evidence-backed promotion:
  `.appsdk/skills/project-memory/SKILL.md`
