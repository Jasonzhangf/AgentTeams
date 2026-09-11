# C1 Provider MVP Audit Receipt

- delivery unit: `c1-provider-live-20260911`
- worker role: independent GCM worker
- base: `origin/main@737266ecc18b06349b7a14064ea8b3f068c71ed4`
- candidate/tree before this receipt: `737266ecc18b06349b7a14064ea8b3f068c71ed4`
- worktree: `/Volumes/extension/code/AgentTeams/playground/c1-provider-live-20260911`
- branch: `codex/c1-provider-live-20260911`
- date: `2026-09-11`
- timezone: `America/Los_Angeles`
- result: source-level C1 satisfied; live provider acceptance blocked

## Scope

Audited only `config/**`, `opencode-adapter/**`, the mapped C1 tests, and this
evidence directory. No `runtime/**`, `network/**`, `server/**`, Console, root
dependency, provider service, or credential source was modified. No credential
value was read into output, source, logs, or this receipt.

## Source-Level Findings

The current source already provides the requested C1 primitives:

- RCC primary instance: `config/runtime-config.spec.ts:37-44` defines
  `rcc-4444` at `http://127.0.0.1:4444/v1`.
- Explicit GoAIChat backup: `config/runtime-config.spec.ts:46-53` defines
  `goaichat-openai` at `https://llm.goaichat.top/v1` with an opaque credential
  reference.
- Multi-instance and model isolation: `RuntimeConfigStore` keys catalogs by
  `providerInstanceId`; the focused test covers same-protocol instances with
  the same model ID remaining isolated.
- Model catalog behavior: the provider client constructs `<apiBaseUrl>/models`,
  sends credentials only in the Authorization header, preserves empty catalogs,
  rejects invalid/duplicate upstream data, and maps HTTP/auth failures to
  explicit typed errors.
- Durable revision/CAS: `createRuntimeConfigStore` loads and atomically saves
  the normalized versioned state; mutations require `expectedRevision` and
  reject stale revisions with `REVISION_CONFLICT`.
- Accepted/effective separation: `applyAcceptedConfig` records
  `effectiveRevision` only after a successful matching apply result and stores
  structured apply errors without claiming effectiveness.
- Restart readback: the focused config test recreates a store from persistence
  and verifies the RCC primary plus GoAIChat backup binding and effective
  revision survive reload.
- OpenCode projection: `compileOpenCodeConfig` resolves the selected primary and
  optional explicit backup into typed provider/model targets. It rejects
  disabled, missing, or unavailable targets.
- Derived launch config: `createOpenCodeLaunchConfig` exposes both selected
  providers and models, keeps credential values out of derived config, and
  rejects inconsistent duplicate provider targets.
- No implicit failover: adapter code only projects the explicit primary and
  optional backup; no retry, automatic switching, or response-model inference
  path was found in the audited scope.
- Apply/readback owner: the actual managed-child apply/readback flow is owned by
  existing `runtime/managed-config-owner.ts` and `runtime/managed-opencode.ts`;
  the C1-owned adapter provides the compile/launch projection consumed by that
  owner. This audit did not modify runtime code.

## Verification

Successful checks:

```text
/Volumes/extension/code/AgentTeams/node_modules/.bin/vitest run --config vitest.config.ts \
  config/config-boundary.spec.ts \
  config/runtime-config.spec.ts \
  opencode-adapter/tests/index.spec.ts \
  opencode-adapter/tests/managed-config.spec.ts \
  opencode-adapter/separator.spec.ts

Test Files  5 passed (5)
Tests       48 passed (48)
```

```text
/Volumes/extension/code/AgentTeams/node_modules/.bin/tsc --noEmit
exit 0

/Volumes/extension/code/AgentTeams/node_modules/.bin/tsc --noEmit -p opencode-adapter/tsconfig.json
exit 0
```

```text
node /Volumes/extension/code/AgentTeams/node_modules/.pnpm/tsdown@0.22.14_typescript@6.0.3/node_modules/tsdown/dist/run.mjs \
  src/index.ts --out-dir lib --format esm --platform node --target es2022 --dts --clean
exit 0
```

```text
git diff --check
exit 0
git status --short --untracked-files=all
clean before this receipt
```

The direct catalog test file was also attempted. It could not run in this
managed sandbox because its test server cannot bind `127.0.0.1`:

```text
/Volumes/extension/code/AgentTeams/node_modules/.bin/vitest run --config vitest.config.ts \
  config/provider-model-client.spec.ts

Error: listen EPERM: operation not permitted 127.0.0.1
```

The focused config store tests cover catalog merge/error semantics without
opening a local listener. The adapter typecheck initially lacked package links
after the frozen install attempt; the links were available in the local
workspace package store for the verification commands above and were removed
afterward. No tracked dependency or lockfile change resulted.

## Live Blocker

The required RCC primary listener was not available at audit time:

```text
curl -sS --max-time 2 -w '\nHTTP:%{http_code}\n' http://127.0.0.1:4444/v1/models

curl: (7) Failed to connect to 127.0.0.1 port 4444 after 0 ms: Couldn't connect to server
HTTP:000
```

The two configured source files exist:

- `/Volumes/extension/.rcc/config.toml`
- `/Volumes/extension/.rcc/provider/goaichat_openai/config.v2.toml`

Their contents and the credential file were not printed or copied. Because the
RCC listener was unavailable, this worker did not start OpenCode or any Teams
daemon, did not perform live catalog/apply/readback/restart, and did not claim
live RCC or GoAIChat inference.

## Exact Diff

This audit made no product-source change. The only intended change is this
receipt:

```text
docs/evidence/c1-provider-live-20260911/receipt.md
```

No candidate code commit was produced because no C1 source defect was found.
The remaining action is to rerun the live catalog and managed OpenCode
apply/readback/restart probes in an environment where RCC `127.0.0.1:4444` is
running and local HTTP test listeners are permitted.
