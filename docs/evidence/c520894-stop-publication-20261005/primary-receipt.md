# 2026-10-05 c520894 stop publication primary closure

- Candidate: `e626114cb84416d40faba863c6ddd82233d2c7b4`, base `7739da440b52c7335a6662e32c0bccb29b6acb7d`.
- Changed paths: `runtime/local-process.ts`, `runtime/local-supervisor.ts`, `runtime/local-supervisor.spec.ts`, `runtime/local-two-agent.spec.ts`.
- Root cause: terminal launcher state was published before the daemon-status projection, and public stop returned on that publication without requiring the detached launcher process to exit.
- Worker evidence: deterministic owner-level red/green, local-supervisor 7/7, typecheck/build/graph/diff PASS. The worker sandbox could not observe `ps` or bind loopback, so the full command and staging remained parent-owned.
- Host focused replay: `/tmp/c520894-host-verify/focused.json`, exit 0, 20 total / 20 passed / 0 failed / 0 pending.
- Host full regression: committed candidate, exit 0, 138/138 suites and 584/584 tests passed, 0 pending/TODO. Regression JSON SHA-256: `8050eef38987af87174b67a1055884f9b7ca6cfc9462d172ace307f4b0c26438`.
- Host public CLI replay outside the source tree: init, generation 1 start/status, generation 1 stop, generation 2 start/status, generation 2 stop, then immediate full `.agentteams` root removal all exited 0; the root was absent after removal.
- Remaining: independent review PASS, clean-main integration, remote receipt, owned-resource cleanup.
