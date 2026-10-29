# c5708f3 Provider Catalog & Apply Readback Acceptance (`BB08,BB10`)

## Scope
- Bug: `c5708f3` (`[V1 P1] Live provider catalog and apply readback acceptance`)
- Driver: `scripts/blackbox-user-mvp.mjs` (`--case BB08,BB10`)
- Candidate receipt: `docs/evidence/c5708f3-provider-catalog-apply-20261028/receipt.json`

## Acceptance Result (`2026-10-28`)
- `BB08` (`installed config generation and stale rejection`): `passed`
  - Proves durable TOML config generation, `expectedRevision` CAS conflict rejection (`REVISION_CONFLICT`), `acceptedBinding` projection readback, and `applyState` transitions on the installed package.
- `BB10` (`installed explicit provider/model session`): `passed`
  - Both configured provider instances route through local RCC port `4444` (`http://127.0.0.1:4444/v1` with `gpt-5.5` and `kk.glm-5.3-flash`), proving `config.refreshModels` catalog readback, `config.apply` effective revision alignment, first real OpenCode Session turn (`rcc_turn`), explicit primary switch (`config.bindModel`, `accepted +1`), explicit backup retention (`config.agent.select-backup`, `accepted +2`), installed launcher restart persistence, second `config.apply` + real OpenCode Session turn (`canonical_turn`), and the deterministic boundary suite (`no_implicit_failover`, `stale_cas`, `invalid_credential`, `manual_selection`).
- Overall exit code: `0` (`passed: 2`, `failed: 0`, `unverified: 0`)
