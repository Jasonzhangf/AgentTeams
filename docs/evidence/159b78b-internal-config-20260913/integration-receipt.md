# Integration receipt: 159b78b

- Worker candidate: `06a63e5a06e02f3aca472e9a2c79e4b375f15aab`.
- Integration base: `caf577cbd1c39688328fb0392d1c638ec76095bc`.
- Integration candidate: `d5dde4658120ac752c6da9c1d8fed2ee1991ca89`.
- The runtime candidate was cherry-picked into a clean integration worktree. The integration
  owner then bound the four architecture maps and retained their runtime owner boundaries.
- Focused integration gate: 5 files, 20 tests passed, including local bridge and two-agent replay.
- Mapped regression: `pnpm test` passed with 77 files and 458 tests.
- `pnpm typecheck` passed.
- `appsdk compile` passed; artifact hash:
  `sha256:057d611dbfb08e300140b713bfc1db94f1e45c284a67ecff33c7dcf174113680`.
- `appsdk verify` passed with `stage=contract_bound`.
- `git diff --check` passed.
- Integration exact review: Codex Review task `159b78b-integration-review-r10`, mode `base`,
  base `caf577cbd1c39688328fb0392d1c638ec76095bc`, candidate
  `d5dde4658120ac752c6da9c1d8fed2ee1991ca89`, verdict `PASS`.
- P2 stale projection cleanup remains tracked by issue `b17014d`; it does not block this unit.
