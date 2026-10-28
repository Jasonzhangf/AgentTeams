# 5abd96e managed OpenCode readiness timeout fix

The only source change aligns the child-exit-before-readiness test budget with
the already-established worst-case startup budget. It is a test-only change:

- `runtime/managed-opencode.spec.ts` line 12: `startupTimeoutMs` changed from
  `1000` to `12000`. The separate deadline test at line 23 keeps `100` to test
  the timeout branch.

The change is committed on branch `fix/5abd96e-readiness-timeout`
(commit `38f777f`), based on `origin/main` `9c31e47`.

## Verification

| Command | Result |
| --- | --- |
| `pnpm exec vitest run runtime/managed-opencode.spec.ts agent-host/cli-executor.spec.ts` | 2 files, 14 tests passed |
| `pnpm exec vitest run opencode-adapter/tests/acp-engine.real.spec.ts` (three consecutive runs) | 4/4 passed each run |
| `TEAMS_CONSOLE_REAL_DOM=1 pnpm test` | 159 files, 1678 tests passed, exit 0 |

The full regression run used real Chrome and completed on the exact candidate
tree before integration.

Raw logs: `focused.log`, `real-1.log`, `real-2.log`, `real-3.log`,
`full-test.log`.
