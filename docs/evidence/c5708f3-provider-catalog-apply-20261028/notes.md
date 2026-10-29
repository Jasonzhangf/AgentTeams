# c5708f3 Provider Catalog & Apply Readback Acceptance (`BB08,BB10`)

## Scope
- Bug: `c5708f3` (`[V1 P1] Live provider catalog and apply readback acceptance`)
- Driver: `scripts/blackbox-user-mvp.mjs` (`--case BB08,BB10`)
- Candidate receipt: `docs/evidence/c5708f3-provider-catalog-apply-20261028/receipt.json`

## Acceptance Result (`2026-10-28`)
- `BB08` (`installed config generation and stale rejection`): `passed`
  - Proves durable TOML config generation, `expectedRevision` CAS conflict rejection (`REVISION_CONFLICT`), `acceptedBinding` projection readback, and `applyState` transitions on the installed package.
- `BB10` (`installed explicit provider/model session`): `unverified` (`missing_capability: "selected rcc model is absent from the current catalog"`)
  - Upstream provider `https://llm.goaichat.top/v1/models` returned HTTP 429 `{"code":"API_KEY_QUOTA_EXHAUSTED","message":"API key 额度已用完"}` for both declared `goaichat` keys on 2026-10-28, so `goaichat.qwen3.8-max` is temporarily absent from the local RCC `/v1/models` catalog.
  - The unchanged `config/runtime-config.ts`, `config/provider-model-client.ts`, `runtime/console-config.ts`, `runtime/managed-config-owner.ts`, and `opencode-adapter/` implementation already passed `BB10` (`status: "passed"`) in `docs/evidence/acp-l13-internal-mvp/bb-all/receipt.json` (lines 2992-3330).
