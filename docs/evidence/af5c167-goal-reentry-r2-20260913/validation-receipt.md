# Validation receipt

- `git diff --check`: PASS.
- `pnpm verify`: PASS on candidate source tree.
  - 77 test files passed.
  - 458 tests passed.
  - Typecheck passed.
  - AppSDK guide compile, compile, packaged Console/runtime smoke, and AppSDK verify passed.
- Scope applicability: runtime install/restart, local socket replay, public Relay, NAT/STUN,
  and device validation are not claims of this documentation-only delivery. They remain
  required gates for the product delivery units named by the goal prompt.
