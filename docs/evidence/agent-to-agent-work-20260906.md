# Agent-to-Agent Work replay

Date: 2026-09-06. Candidate commit `5bb192f` was merged as PR #16 at
`cf7756aa5dde23669ba134578ce2aeebe788772b`.

`runtime/agent-process.spec.ts` starts two independent `startAgentProcess`
daemons (`provider2` and `consumer2`) against the local TLS Relay. The
consumer daemon confirms the provider in the Relay directory, obtains an
authenticated data grant, opens a Work channel, proposes `file-search`, runs a
fixed-root search, receives the matching line, closes the Work, and stops both
daemons. No Console host participates in this path.

Evidence:

- Focused replay: `pnpm exec vitest run runtime/agent-process.spec.ts` — 2
  tests passed.
- Main regression after merge: `pnpm test` — 60 test files / 318 tests passed.
- Main typecheck after merge: `pnpm typecheck` — root, adapter, Console host,
  and UI checks passed.
- AGY exact commit review `agentteams-n2-cross-daemon-commit-20260906` — PASS,
  no P0/P1 findings.
- Evidence archive:
  `playground/evidence-archive/agent-to-agent-work-20260906/review-evidence.tgz`
  SHA-256 `fe36b66bbe973ffe413b65c261b3ba958f4e04fdae625c6429ad4c7d42a1eeab`.

This proves local two-daemon Relay discovery and Agent-to-Agent Work execution
without Console. It does not prove public Relay ingress, NAT traversal, direct
transport, mobile access, installed service deployment, or production Relay
configuration.
