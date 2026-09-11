# C1 integration receipt

- delivery unit: `c1-provider-live-20260911`
- integration worktree: `/Volumes/extension/code/AgentTeams/playground/integration-c1-20260911`
- base: `origin/main@737266ecc18b06349b7a14064ea8b3f068c71ed4`
- integrated candidate before this receipt: `fbf9c6b`
- integrated tree before this receipt: `206e051ed306f766d321ae9e3a5d4a5390ea072f`
- candidate commit: `a7736d873ed5e19d8d63411a6c2bb2c1d328ab0b`
- result: integration evidence recorded; live provider acceptance remains blocked

## Integration

The C1 receipt-only candidate was cherry-picked onto a clean worktree created
from the current `origin/main`. No product source, configuration, lockfile, or
runtime behavior changed in integration.

The isolated worktree initially had no dependencies. `pnpm install
--frozen-lockfile --offline` then completed from the pre-provisioned local
package store without network access:

```text
Lockfile is up to date, resolution step is skipped
Packages: +97
reused 97, downloaded 0
Done in 889ms using pnpm v10.31.0
```

## Verification

Passed:

```text
pnpm typecheck
appsdk guide compile
appsdk compile
appsdk verify
git diff --check
```

`appsdk compile` produced artifact hash:

```text
sha256:d24505b87e5284392737f241090b7bde809281c02284913cac655b4cdf62082c
```

The packaged Console smoke passed its authenticated UI/API and Session JSON
checks. Runtime smoke did not complete because this sandbox cannot reliably
bind the local TLS listener; the owned smoke process was stopped after it
remained blocked. No provider, relay, NAT, or cross-device claim is derived
from that smoke run.

The full regression command reached the test runner but ended with the known
local-listener environment boundary:

```text
123 suites total; 116 passed; 7 failed
420 tests total; 384 passed; 36 failed
```

Failures were local `listen EPERM`/startup timeout paths. They do not alter the
C1 receipt's source-level versus live-provider boundary. No live RCC `4444`
catalog/apply/readback/restart was observed.

## Cleanup

All integration-only dependency links, generated build output, and temporary
runtime-smoke state were removed before delivery. The only retained files are
the C1 worker receipt and this integration receipt. The main worktree remained
clean; no remote process or service was started by this integration unit.
