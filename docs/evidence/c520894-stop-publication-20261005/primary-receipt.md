# 2026-10-05 c520894 stop publication primary closure

- Code fix commit: `9975163dc774629b6ba9a89f3e3c1907a6433a68`; integrated base `6252db854c2bd8d63a100a051f76cfaf88fbbbe5`.
- Delivered candidate: the final commit that contains this receipt. Its exact hash is recorded in the post-commit public replay receipt named below, whose `candidate.head_commit` equals that final commit.
- Changed paths: `runtime/local-process.ts`, `runtime/local-supervisor.ts`, `runtime/local-supervisor.spec.ts`, `runtime/local-two-agent.spec.ts`.
- Root cause: terminal launcher state was published before the daemon-status projection, and public stop returned on that publication without requiring the detached launcher process to exit. The later hardening makes daemon records and the launcher terminal state a single durable recovery write so a failed terminal state cannot remain stale after an unconfirmed status projection write.
- Worker evidence: deterministic owner-level red/green, local-supervisor 7/7, typecheck/build/graph/diff PASS. The worker sandbox could not observe `ps` or bind loopback, so the full command and staging remained parent-owned.
- Host focused replay at source fix candidate `9975163dc774629b6ba9a89f3e3c1907a6433a68`: local-process, local-supervisor, local-two-agent, previously failing runtime/host suites passed; local-process is 12/12 and the targeted suite set is 40/40.
- Host full regression at source fix candidate `9975163dc774629b6ba9a89f3e3c1907a6433a68`: exit 0, 82/82 test files and 584/584 tests passed, 0 pending/TODO.
- Host runtime typecheck at source fix candidate `9975163dc774629b6ba9a89f3e3c1907a6433a68`: exit 0.
- Host public CLI replay at the delivered final commit outside the source tree: installed final package init, generation 1 start/status/stop, generation 2 start/status/stop, and Console entrypoint checks all exited 0. Post-commit receipt: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/c520894-stop-publication-20261005-r7/installed-runtime-smoke.receipt.json`. Its `candidate.head_commit`, SHA-256, generation sequence, PIDs, and cleanup status are the authoritative exact-delivered evidence.
- This evidence commit records the receipt binding only. Parent reviews the exact final commit after the post-commit validation.
- Remaining: independent review PASS, clean-main integration, remote receipt, owned-resource cleanup.
