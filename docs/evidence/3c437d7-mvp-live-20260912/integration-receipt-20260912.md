# 3c437d7 evidence repair integration receipt

- Delivery unit: `3c437d7`
- Source candidate: `76ad86943a6911869c57877695b7805e0fcae1d5`
- Candidate exact review: `3c437d7-final-exact-review-20260912` (PASS)
- Integration base: `origin/main@b2bc4aa36e845e3243e8db3326c6a71cd0ea5fb7`
- Integration worktree: `playground/3c437d7-claw-public-nat-20260912-integration`
- Integrated commit before this receipt: `673d5cc`

The candidate was merged into a clean worktree created from the fetched
`origin/main`. The merge had no conflicts and changed only the tracked review
receipt plus the existing project-memory L2 evidence binding and its canonical
JSONL event.

Integration validation on the exact merged tree:

```text
project-memory index       PASS
project-memory verify      PASS (56 nodes, source_consistent=true)
git diff --check           PASS
pnpm install --frozen-lockfile PASS
pnpm verify                PASS (75 files / 447 tests; typecheck; AppSDK guide compile;
                             AppSDK compile; packaged Console/runtime smoke; appsdk verify)
```

The runtime and deployment inputs were unchanged; the public Relay/NAT/
Console-offline replay remains bound to the previously reviewed source and its
tracked receipts. This integration evidence does not claim provider catalog,
direct transport, NAT-to-NAT, mobile replay, or full MVP closure.
