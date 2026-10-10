# 作者验证：AppSDK 0.1.0014 升级与规则审计

候选：`codex/sdk-refresh-0.1.0013-20261009`，被测提交 `dd6b0e1`（审计记录补 CI 行前的
同一树，见下）。工作树：`/Volumes/Intel/playground/agentteams/sdk-refresh-0.1.0013-20261009`。
证据目录：`/Volumes/Intel/playground/agentteams/.worker-runs/sdk-refresh-0.1.0013-20261009/`。

## 命令与结果

| 命令 | 退出码 | 结果 | 证据 |
| --- | --- | --- | --- |
| `appsdk verify`（pin 0.1.0012，升级前） | 1 | `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0012:required_binary=appsdk-0.1.0012` | `verify-before.err` |
| `appsdk pin-lock . --binary /Users/fanzhang/.cargo/bin/appsdk` | 0 | 物化 `0.1.0012-to-0.1.0013`、`0.1.0013-to-0.1.0014` 迁移；bundle 重写 | `pin-lock.out` |
| `appsdk pin-lock`（00:00 二进制重建后） | 0 | `compiler_digest` 刷新；bundle digest 不变 | `git show 5393424` |
| `appsdk sdk-witness .` | 0 | 二进制见证与 pin 一致 | — |
| `appsdk guide compile`（审计改动后） | 0 | `.appsdk/guidance/compiled.json` 摘要更新 | `guide-compile.out` |
| `appsdk verify`（审计改动后） | 0 | `baseline_status=current`、`development_ready=true`、`test_governance.mode=off` | `verify-after-audit.out` |
| `pnpm verify`（提交 `dd6b0e1`） | 0 | 全量门禁通过 | `pnpm-verify-audit.out`、`pnpm-verify-audit.err` |
| `node scripts/regression.mjs`（门禁内） | 0 | `success=true`、164 suites、failed 0、776/776、pending 0、todo 0 | `regression-audit.json` |

## 事实

- `appsdk pin-lock` 与 `guide compile` 只改 `.appsdk/**`；产品源码、测试、`docs/architecture/`
  与 `.appsdk/` 之外的 map 未变（`git status --porcelain | grep -v '^.M \.appsdk/'` 为空）。
- `appsdk compile` 要求索引干净：`appsdk guide compile` 会重写受跟踪的
  `compiled.json`，不先提交就报 `receipt identity: staged product does not match the recorded index`。
  因此升级与审计各自在提交后重跑门禁。
- 门禁在本机 load 6–16 下通过；同一候选此前在未提交索引时会得到 23 个 pending 的
  `package-install.spec.ts`，那不是产品缺陷。

## 未验证边界

- 本记录不证明运行时行为、安装副本、BB01–BB14 验收、正式 review、merge、远端回执或发布。
- `docs/evidence/92e96dc-sdk-rule-upgrade-20261010/` 在 `dd6b0e1` 之后追加了 CI 差异行
  （D11）。该改动只增审计文档，不改变任何 rule source 或 gate 输入，故复用 `dd6b0e1`
  的 `pnpm verify` 证据；受影响检查只有 `appsdk verify` 与 `guide compile`，两者在追加后
  仍需退出 0。
- 拒绝项（commit/push 钩子、CI workflow、SDK `test_governance`）没有被实现，因此没有
  对应的通过证据；它们是记录在案的保留决定，不是未完成项。
