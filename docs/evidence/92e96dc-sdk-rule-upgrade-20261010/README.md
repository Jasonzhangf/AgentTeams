# AppSDK 0.1.0014 升级与规则/Skill 升级审计

任务：git-bug `92e96dc`。输入基线：`origin/main@f7a57e9`。审计候选：
`codex/sdk-refresh-0.1.0013-20261009`。用户指令：「你先升级到appsdk最新版本,
开始治理改造」。

## 事实

- 共享二进制 `/Users/fanzhang/.cargo/bin/appsdk` 在 2026-10-09 21:45 从 0.1.0012 变为
  0.1.0013，又在 00:00 重建为 0.1.0014（`appsdk version` 报 `0.1.0014`）。
- `.appsdk/project.json` 原 pin `sdk.version = 0.1.0012`。SDK 源码
  `rust/src/main/project.rs:85-95` 在 `sdk.version != SDK_VERSION` 时直接 fail，因此
  `appsdk verify`、`pnpm verify`、`pnpm lifecycle:admission` 与 BB13 验收全部失败，
  报 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0012:required_binary=appsdk-0.1.0012`。
- 升级走官方入口：`appsdk pin-lock . --binary /Users/fanzhang/.cargo/bin/appsdk`。
  它按记录的 `0.1.0012-to-0.1.0013`、`0.1.0013-to-0.1.0014` 步骤重写 SDK-owned bundle
  （contracts、sdk.lock、sdk-resources、docs、rules、skills）并物化两份迁移记录。
  产品源码、测试与 `.appsdk/` 之外的 map 未变。
- `appsdk guide compile` 重写了受跟踪的 `.appsdk/guidance/compiled.json` 摘要；
  不提交它会让后续 `appsdk compile` 报
  `receipt identity: staged product does not match the recorded index`。
- 二进制在 00:00 重建后 `sdk-witness` 报 `SDK_WITNESS_BINARY_MISMATCH`，重新
  `pin-lock` 后 `sdk-witness` 退出 0；bundle digest 未变（`sha256:868fe60e...`），
  只有 `compiler_digest`/`digest` 变化。

## 交付内容

- [rule-audit.md](rule-audit.md)：逐差异审计（path、owner、action、basis、保留保障、
  受影响入口），含被拒模板项。
- [verification.md](verification.md)：作者定向验证结果。
- 生效规则改动：根 `AGENTS.md`、`docs/development-governance.md`。
- SDK-owned 改动：`.appsdk/**`（由官方 `pin-lock` 与 `guide compile` 产生，不手改）。

## 证据边界

本目录是规则审计的交付材料。它证明规则比对、改动与定向验证；不证明运行时行为、
安装副本、正式 review、merge、远端回执或发布。这些各有独立结果，在相应动作完成后
归档。静态审计不证明 runtime 正确。
