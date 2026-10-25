# Teams Project Contract

## Project truth

- Teams is an independent multi-agent control plane. Agents may be passive
  capability services, including browser CLI agents. OpenCode and DSH are engine
  adapters for LLM agents; Teams owns its UI and provider configuration.
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
- Current product increment: the ACP daemon, control daemon and registration
  server delivery. ACP carries generic inference interaction; an engine adapter
  carries engine-specific features; the first engines are OpenCode and DSH.
  Teams owns identity, network, negotiation, master/peer roles and capability
  policy. Capability is the intersection of engine support, adapter, accepted
  config and negotiated connection, and a role never grants extra authority.
- Each config file declares exactly one daemon (`agent`, `control` or `registry`)
  with its own identity and data directory. Multiple targets use multiple files
  started separately. `agentteams --serve <opencode|dsh> --ip <ip> --port <port>`
  is the user quick-start entry. One config never starts a second daemon or an
  implicit control/registry.
- The single-daemon config and public ACP/engine/Teams contracts are defined in
  `docs/design/teams-acp-daemon-config-v4.md`. One `engineAdapterFor` dispatch in
  `runtime/acp-serve.ts` selects OpenCode or DSH; daemon/host/stdio/readiness/stop
  plumbing is shared. Delivery status belongs to the scoped plans and evidence,
  not a second progress table here. A declared frame or parse test does not prove
  engine inference or a usable UI.
- The ACP increment does not replace the existing Work entry. Old Work
  obligations and their acceptance remain in force, and none of their evidence
  proves the ACP increment.
- The authorized group WebUI first increment is a human-operated issue/action
  loop. Model execution and ACP Session mapping are a separate second increment;
  webhook acceleration is third. Work MVP, ACP/LAN and group delivery each need
  their own evidence. See `docs/goals/teams-user-delivery-plan.md` and
  `docs/design/teams-group-messaging-v1.md`.
- Compatibility boundary: the Phase 1 local-network MVP and the current
  ACP/LAN/WebUI increment are the supported scope. Public Relay, real NAT/STUN,
  direct internet transport, mobile entrypoints, central registration
  deployment, the removed legacy host UI, and empty admission scaffolding are
  out of scope and are not restored. Each phase binds its own gate. See
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

## Group architecture and workflow

These are product constraints, not a claim that all paths are implemented.
Protocol fields, state transitions and DAGs have one owner:
`docs/design/teams-group-messaging-v1.md`. Human interaction is owned by
`docs/design/teams-group-webui-design.md`; the HTML beside it is a simulation.

- The human path is discovery → select an authorized Agent context → create or
  enter a group → select/create an issue → explicitly assign actions → read
  results → follow up or close the issue. Switching groups/issues preserves
  their own drafts and pending operations; late responses cannot replace the
  current view. Choosing a daemon context does not switch authenticated users.
- Console/UI submits typed requests to the existing Agent endpoint and hub.
  `packages/shared` owns wire contracts; the server hub owns group membership,
  issue-session links, actions and external-operation delegation records.
  Runtime connects the transport and local execution owners. Console never
  owns a second business ledger or the Agent-to-Agent relay path.
- Vikunja owns issue open/closed state. The delegated daemon's `vikunja-sync`
  owns the external call; hub projects its authenticated result. One group has
  many issue sessions; one issue has one conversation. Local ACP Sessions are
  execution bindings, not the navigation or issue-state authority.
- Group messages are shared. `@` selects action responsibility, not private
  visibility. Each request identifies its initiator/reply recipient, issue,
  action, assignee, reason, expected result and reply requirement. A valid action
  assigned to the Agent triggers work; `replyRequired` only controls the reply.
  Comments and received messages do not implicitly start another action.
- Group management, command authority and issue-close authority are separate.
  A master's explicit `mastersOf` edge allows assignment to that peer and a
  request from that peer to the master. The master may refuse with a reason;
  the peer may report evidenced blockage/failure, but cannot refuse a valid
  assignment. Roles never bypass system permissions or capability limits.
- Each participant ends its action after its result is confirmed in the issue.
  Follow-up creates a new action; blocked actions are not silently resumed.
  The initiator closes/reopens the same issue, or explicitly delegates this to
  a named member. Group admin rights alone do not grant that delegation.
- Closing stops admission, cancels unstarted actions and requests cancellation
  of in-flight work. Issue closed and execution stopped are separate facts.
  External close uses the same settlement path. Reopening does not replay old
  actions; late messages remain history. Leaving/hiding a group or switching
  views does not close its issues.
- A send receipt, durable inbox ACK, completed action and closed issue prove
  different boundaries. Keep stable commit/result identifiers for uncertain
  writes; recover by authoritative readback without blind replay. A successful
  list never settles an uncertain write. `issue.list` reads persisted sessions
  under group authorization; `issue.query` refreshes external state. Stale or
  unknown state cannot authorize a new action.
- Show only feedback that changes the user's decision, action or recovery.
  Per-Agent cards and the overall summary expose distinct responsibilities and
  unfinished actions. Motion follows real state; timestamps alone do not remount
  inputs, clear drafts or announce progress. Keep refusal, unknown, history
  gaps, unconfirmed stop and accessibility feedback; omit duplicate ACK/toasts.

## Development contract

- For AgentTeams development, debugging or acceptance, read the project-local
  `.agents/skills/agentteams-development/SKILL.md`. It owns the project procedure
  and routes to the existing design/maps/gates; it does not replace global
  orchestration, grant permissions or alter SDK-managed Skills.

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
- The project's commit and push protection is procedural: a complete product
  milestone needs applicable validation and one independent overall review
  before integration. Pure documentation/Skill edits use targeted checks;
  internal steps do not each require a review. The project declares no
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
  replay, review, merge, remote receipt and cleanup separately. Never
  infer a later evidence level from an earlier one.
- A blocked result names the first failing gate, the preserved state, the retry
  policy, the owner, and one executable next action.

## Canonical surfaces

- Requirements and design: `docs/`
- Architecture maps: `docs/architecture/`
- AppSDK maps and contracts: `.appsdk/`
- Runtime source: `agent-host/`, `network/`, `server/`, `runtime/`,
  `packages/shared/`, `packages/dagpipe/`, `opencode-adapter/`, `console-host/`, `ui/`
- Project facts and boundaries: this file. Project development procedure:
  `.agents/skills/agentteams-development/SKILL.md`. Commands, gate applicability
  and evidence reuse: `docs/development-governance.md`. Machine workflow:
  the declared `.appsdk/` guidance contracts. SDK-owned Skills stay under
  `.appsdk/skills/`; do not put this project's procedure there.
- Optional memory retrieval, level-3 writes, and evidence-backed promotion:
  `.appsdk/skills/project-memory/SKILL.md`
