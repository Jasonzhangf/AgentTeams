# Candidate receipt: local MVP dispatch refresh

- Delivery unit: documentation-only goal and dispatch refresh.
- Base: `origin/main@bc2b209d2806c0a9f95199acd3de0988ac6b6bbe`.
- Candidate commit: recorded by `git rev-parse HEAD` after this receipt is amended; the exact review
  is a separate gate against that immutable candidate.
- Changed paths are limited to the three goal documents and this evidence directory.
- The refresh records the current runtime rebind state, L1/C1 retained worktrees, dependency order,
  resource ownership, re-entry rule, and the single copy-paste `/goal` prompt.
- Product implementation, runtime behavior, network replay, and public Relay acceptance are not claimed.
- Initial `pnpm verify` stopped because this fresh worktree had no `node_modules` and reported
  `tsdown: command not found`; after `pnpm install --frozen-lockfile --offline`, the recorded
  `pnpm verify` passed.
