# Integration receipt: 56baa57

- Base: `1aeccee0200d80f55299dcdc4dabf5b43264c219` (`origin/main` at integration start)
- Candidate commits: `0002699`, `c9f44e4`, `030cc64`, `ac9c630`
- Integrated tree: `da8fd80186d5e3743f5dc0e1b5d7b93bc4d0bde8`
- Integration worktree: `playground/56baa57-integration-20260912`
- Changed semantic paths: `.appsdk/goal.json`, `docs/architecture/verification-map.json`,
  `docs/development-governance.md`, `docs/goals/**`, `note.md`

## Validation

- `git diff --check`: PASS
- `jq empty .appsdk/goal.json`: PASS
- `jq empty docs/architecture/verification-map.json`: PASS
- `appsdk guide compile`: PASS
- `appsdk compile`: PASS
- `appsdk verify`: PASS (`stage=contract_bound`)
- `pnpm verify`: PASS
  - 75 test files, 447 tests
  - typecheck and package builds PASS
  - packaged Console smoke PASS
  - packaged runtime smoke PASS

The changed profile does not claim that public Relay, NAT, mobile, direct
transport, or full UI acceptance is complete.
