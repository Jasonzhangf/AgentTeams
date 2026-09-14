# 3742b9a Runtime R6 Validation Evidence

## Install

```sh
pnpm install --frozen-lockfile --prefer-offline
```

Exit code: `0`

## Red signal before implementation

Minimal r6 tests were added first for detached start/status/stop/generation and configured-Work restart persistence.

```sh
pnpm exec vitest run runtime/local-process.spec.ts --reporter=dot
```

Exit code: `1`

Raw blocker:

```text
TypeError: startLocalProcess is not a function
```

Tests: `2 failed | 1 passed (3)`.

## Focused runtime suites

```sh
pnpm exec vitest run runtime/local-config.spec.ts runtime/local-process.spec.ts runtime/local-supervisor.spec.ts --reporter=dot
```

Exit code: `0`

Result:

```text
Test Files  3 passed (3)
     Tests  22 passed (22)
```

This proves detached `start/status/stop`, generation increment, stale stop rejection, configured-Work receipts across restart generations, internal write serialization, and stale receipt rejection.

The timeout cancellation regression is also green:

```sh
pnpm exec vitest run runtime/local-process.spec.ts --reporter=dot
```

Result: `1 passed (4 tests)`; a timed-out detached supervisor is marked failed
and cannot publish a late `running` state.

## Socket-backed suites

An initial combined invocation used the default Vitest worker pool and failed while
several child test processes attempted loopback listeners concurrently. The same
mapped command was rerun after the transient resource pressure cleared:

```sh
pnpm exec vitest run runtime/local-two-agent.spec.ts runtime/agent-process.spec.ts runtime/local-relay-bridge.spec.ts --reporter=dot
```

Exit code: `1` for the initial attempt.

Raw blocker:

```text
listen EPERM: operation not permitted 127.0.0.1
```

Initial result: `Test Files  3 failed (3)`, `Tests  7 failed | 1 passed (8)`.

The mapped suites then passed with the same default command:

```sh
pnpm exec vitest run runtime/local-two-agent.spec.ts --pool=threads --maxWorkers=1 --reporter=dot
```

Result: `1 passed (1)`.

The exact combined command now passes as well:

```sh
pnpm exec vitest run runtime/local-two-agent.spec.ts runtime/agent-process.spec.ts runtime/local-relay-bridge.spec.ts --reporter=dot
```

Result: `Test Files 3 passed (3)`, `Tests 8 passed (8)`.

```sh
pnpm exec vitest run runtime/agent-process.spec.ts --pool=threads --maxWorkers=1 --reporter=dot
```

Result: `1 passed (6 tests)`.

```sh
pnpm exec vitest run runtime/local-relay-bridge.spec.ts --pool=threads --maxWorkers=1 --reporter=dot
```

Result: `1 passed (1)`.

The direct loopback probe also passes in the current shell:

```sh
node -e "const s=require('node:net').createServer(()=>{}); s.on('error', e=>{ console.error(e.code, e.message); process.exit(1) }); s.listen(0,'127.0.0.1',()=>{ console.log('listening'); s.close() })"
```

Exit code: `0`

```text
listening
```

The earlier EPERM is retained as a failed historical attempt; the later exact
socket-backed replay is the current evidence for this candidate.

## Typecheck and runtime build

```sh
pnpm typecheck
```

Exit code: `0`

```sh
pnpm build:runtime
```

Exit code: `0`

## Full verify

```sh
pnpm verify
```

The first attempt returned exit code `1` while the host was under loopback
listener pressure. A subsequent unchanged command passed:

```sh
pnpm verify
```

Exit code: `0`; regression `77` suites and `463` tests passed, followed by
typecheck, AppSDK guide/compile/verify, and smoke.

Regression summary:

```text
numTotalTestSuites: 129
numPassedTestSuites: 107
numFailedTestSuites: 22
numTotalTests: 462
numPassedTests: 341
numFailedTests: 121
```

Raw terminal blocker:

```text
Error: Regression process failed: status=1, signal=null
```

Observed failure family in retained log: `listen EPERM: operation not permitted 127.0.0.1`.

For diagnostic separation, the equivalent full Vitest regression also passed with
the single-thread pool:

```sh
TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --config vitest.config.ts --pool=threads --maxWorkers=1 --reporter=dot
```

Exit code: `0`; `Test Files 77 passed (77)`, `Tests 462 passed (462)`.

The remaining AppSDK and smoke gates also pass:

```sh
appsdk guide compile   # exit 0
appsdk compile         # exit 0
pnpm smoke             # exit 0
appsdk verify          # exit 0
```

## Next step

The current candidate has a passing default `pnpm verify` receipt. The earlier
EPERM attempt remains historical evidence of transient listener pressure only.
