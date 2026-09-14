# Candidate receipt

- Issue: `21622f7` — Persist daemon stopped state across restart generations.
- Base: `4a1fb9b5ca43d4110436dc2ba753f6d8aa00d473` (`origin/main` at dispatch).
- Candidate commit: `063ff29f3c7d4597b1247c9f7e745184c2552c35`.
- Candidate worktree: `playground/21622f7-daemon-stop-20260914`.
- Changed paths: `runtime/local-config.ts`, `runtime/local-supervisor.ts`,
  `runtime/local-process.spec.ts`, `runtime/local-two-agent.spec.ts`.
- Scope: launcher-owned daemon lifecycle persistence. Child network generation is no longer
  written into the launcher generation field; relay orphan state is reconciled on reload.
- Candidate worktree was clean after commit. No CLI, network protocol, provider, dependency, map,
  or generated source changes were included.
