# e8dc905 integration receipt

- Integration worktree: `playground/integration-e8dc905-20260912`
- Integration commit: `07baf9ac8454b458f971eaf0c95060c903cf686f`
- Integration tree: `e735690f15f975bf81e3d86d867257a0b2213734`
- Base: `origin/main` at `74cb6f25d2b68a0d9b28682bc04153d74f9dc91d`
- Candidate merged: `79d75c44fe9b5390b9158273575edcc53fbd38e9`

Validation on the exact integration source passed:

- focused: 5 files / 24 tests;
- `pnpm test`: 75 files / 447 tests;
- `pnpm typecheck`;
- `pnpm build`;
- `appsdk guide compile`, `appsdk compile`, `appsdk verify`;
- `pnpm smoke` after AppSDK compilation: packaged Console and local TLS Relay runtime smoke;
- `pnpm lifecycle:admission`: AppSDK verify, isolated install/restart, and installed runtime smoke.

The first `pnpm smoke` attempt before `appsdk compile` failed with an expected missing generated module (`generated/modules/teams-source/lib/console-host/index.mjs`). It was not reused; the correct compile-then-smoke sequence passed.
