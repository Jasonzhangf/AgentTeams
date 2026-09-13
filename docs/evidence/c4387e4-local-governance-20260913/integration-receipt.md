# c4387e4 integration receipt

- Issue: `c4387e4`
- Base: `origin/main@1555ca4b05dd016a242bdba7fca1865f9459620c`
- Candidate commit: `4c695f5e5f8a203970f6904bcb6a80e65b399dff`
- Candidate tree: `c426d94b1d416b6c09f107215cb6f16e8cd59514`
- Exact review: `c4387e4-governance-review-r9-oauth`; controller verdict `pass`;
  findings empty.
- Integration commit before this evidence commit: `d38ff7782d1a0f2475e1f9b85ff8936a5f5c3a7d`
- Integration tree before this evidence commit: `c426d94b1d416b6c09f107215cb6f16e8cd59514`
- Evidence commit: recorded by the commit containing this receipt.

## Integrated paths

The integration contains the Local Network governance profile, architecture and
protocol maps, the tracked AppSDK guidance artifact, and the c4387e4 validation
logs. No runtime, provider, UI, dependency, or generated runtime source path
was changed.

## Verification

Executed in this clean integration worktree against the candidate tree:

- `pnpm install --frozen-lockfile`: PASS
- `git diff --check`: PASS
- JSON map and manifest cross-reference parse: PASS
- `pnpm verify`: PASS
  - regression: 75 files / 447 tests
  - typecheck: PASS
  - AppSDK guide compile: PASS
  - AppSDK compile: PASS
  - package/runtime smoke: PASS
  - AppSDK verify: `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`
- packaged artifact hash: `sha256:8c254253f55898c8f9a42dff64175bf3921a66302dd887312c5b07fe3219a275`

This integration receipt proves governance and artifact consistency only. It
does not claim local daemon launch, local socket replay, provider dispatch,
Console-offline Work, public Relay, NAT, mobile, or deployment completion.
