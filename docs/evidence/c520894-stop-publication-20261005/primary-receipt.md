# 2026-10-05 c520894 stop publication primary closure

- Source candidate: `d0b1199a33bd61988e46f1f6b750c54b5461f9e76`; integrated base `6252db854c2bd8d63a100a051f76cfaf88fbbbe5`.
- Changed paths: `runtime/local-process.ts`, `runtime/local-supervisor.ts`, `runtime/local-supervisor.spec.ts`, `runtime/local-two-agent.spec.ts`.
- Root cause: terminal launcher state was published before the daemon-status projection, and public stop returned on that publication without requiring the detached launcher process to exit.
- Worker evidence: deterministic owner-level red/green, local-supervisor 7/7, typecheck/build/graph/diff PASS. The worker sandbox could not observe `ps` or bind loopback, so the full command and staging remained parent-owned.
- Host focused replay at source candidate `d0b1199a33bd61988e46f1f6b750c54b5461f9e76`: `/tmp/c520894-host-verify/focused-rebased.json`, exit 0, 20 total / 20 passed / 0 failed / 0 pending.
- Host full regression at source candidate `d0b1199a33bd61988e46f1f6b750c54b5461f9e76`: exit 0, 82/82 test files and 584/584 tests passed, 0 pending/TODO.
- Host public CLI replay at source candidate `d0b1199a33bd61988e46f1f6b750c54b5461f9e76` outside the source tree: init, generation 1 start/status/stop, generation 2 start/stop, and immediate full `.agentteams` root removal all exited 0; the root was absent after removal.
- This evidence commit records the receipt binding only. Parent reruns the public CLI replay after committing this receipt, then reviews the exact final commit including it.
- Remaining: independent review PASS, clean-main integration, remote receipt, owned-resource cleanup.
