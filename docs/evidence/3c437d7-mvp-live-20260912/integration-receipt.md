# 3c437d7 integration receipt

- Source candidate: `03ca70c` (receipt-only, based on `68aacf7`)
- Integration worktree: `playground/3c437d7-mvp-live-20260912-integration`
- Integration commit: `3c97ce0`
- Integration base: `origin/main@68aacf79d0db36f2c2e3a963c2b51b0bcb00443a`

The candidate was cherry-picked into a clean worktree from the latest
`origin/main`. The first cherry-pick attempt was aborted because only the
second receipt commit was selected; the complete two-commit candidate was then
applied in order, with no unresolved conflict.

Integration validation on the exact integrated tree:

```text
pnpm install --frozen-lockfile  PASS
pnpm verify                    PASS
  71 test files / 431 tests
  typecheck, build, AppSDK guide compile, AppSDK compile
  packaged Console/runtime smoke
  appsdk verify: {"ok":true,"project_id":"agentteams","stage":"contract_bound"}
git diff --check               PASS
git status                     clean
```

No runtime source, dependency, generated artifact, or production configuration
changed during integration. The public Relay/NAT/Console evidence remains
bound to the unchanged source candidate and is retained in `receipt.md`.
