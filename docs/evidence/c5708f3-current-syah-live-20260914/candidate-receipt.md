# c5708f3 current-SHA provider replay

- Issue: `c5708f3`
- Candidate source/base: `18279c48c26af725e98de7194c59d600b115f77a`
- Worktree: `playground/c5708f3-current-syah-live-20260914`
- Scope: current-SHA RCC/GoAIChat provider refresh, Agent/Relay apply/readback, runtime restart readback, and managed OpenCode dispatch.
- Owner: provider/OpenCode evidence unit; no product source changes.

## Results

- RCC `GET http://127.0.0.1:4444/v1/models`: HTTP 200 with `dataCount=0` and `modelsCount=0` (`rcc-probe.log`). The configured manual `rcc-4444/gpt-5.5` entry remained usable; no model was inferred from an upstream response.
- GoAIChat credentialed refresh: 18 model entries, including explicit `qwen3.8-max` (`agent-relay-harness.log`). The credential value was supplied through `GOAICHAT_TOKEN` and is not retained here.
- Real local TLS Relay plus Agent process: `config.refreshModels` for both providers and `config.apply` returned `ok`; `acceptedRevision=5`, `effectiveRevision=5`.
- After Agent stop/start, Relay projection still returned `acceptedRevision=5`, `effectiveRevision=5`.
- Managed OpenCode dispatch selected `rcc-4444/gpt-5.5` and `goaichat-openai/qwen3.8-max` independently; both returned HTTP 200 with the expected markers (`opencode-harness.log`). No automatic failover was exercised.
- The RCC response model is not used as Teams configuration truth.

## Verification

- `pnpm exec vitest run config/provider-model-client.spec.ts config/runtime-config.spec.ts runtime/managed-config-owner.spec.ts runtime/managed-config-live.spec.ts runtime/managed-opencode-session.spec.ts runtime/agent-process.spec.ts opencode-adapter/tests/managed-config.spec.ts`: exit 0.
- `pnpm typecheck`: exit 0.
- `appsdk compile`: exit 0.
- `appsdk verify`: exit 0; development baseline verified, delivery admission remains separate.
- `git diff --check`: exit 0.

Raw outputs and independent exit records are retained beside this receipt. This replay does not claim public Relay, NAT, mobile, OS-level daemon installation, or production deployment.
