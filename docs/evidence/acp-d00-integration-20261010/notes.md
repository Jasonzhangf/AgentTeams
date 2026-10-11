# D00 主集成治理同步 — receipt

日期：2026-10-10，America/Los_Angeles。
候选：`codex/acp-d00-integration-20261010` @ `9070c456cb7ca82efdf3c650008e6eef4b70fa99`
（tree `e1577314cbc9112fb931ed5efe439c301aed8e28`）。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d00-integration-20261010`。
Base：`9a511de`（本地 main = `origin/main@1b53e2b` + D00 两个提交 `8c17479`、`9a511de`）。
本 receipt 由随后的 docs-only 提交携带，因此它不能位于它自己绑定的那个提交里。

## 交付内容

只做 D00 剩余的主集成边界：产品合同与治理入口同步、五张 map 的 planned 绑定、本
receipt。不改 `cli/**`、`runtime/**` 或其他源码。

| 文件 | 变更 |
| --- | --- |
| `AGENTS.md` | 声明 ACP daemon/控制端/注册服务增量、一份配置一个 daemon、`--serve` 用户入口、待交付边界；保留旧 Work 义务 |
| `docs/development-governance.md` | 新增三个 D00 gate 与接线边界；planned/design gate 不标 passed |
| `docs/goals/teams-long-running-delivery.md` | 新增 ACP 增量 profile；保留 Phase 1 Local Network MVP profile 及其 live gates |
| `docs/architecture/resource-map.json` | 新增 5 条 D00 真源：daemon intent、ACP policy、ACP frame/fault、engine adapter port、Teams connection |
| `docs/architecture/function-map.json` | 新增 5 个函数绑定，待接线项标 `binding_status: binding-pending` |
| `docs/architecture/mainline-call-map.json` | 新增 `daemon-config-compile-v1`（partial）与 `acp-serve-entry-v1`（design）链及 planned_bindings |
| `docs/architecture/module-registry.json` | 更新 config、control-protocol、agent-host、acp-adapter、cli-facade 的 owner note |
| `docs/architecture/verification-map.json` | 新增 `teams-acp-daemon-intent`、`teams-acp-public-contract`（partial，有可执行命令）与 `teams-acp-serve-entry`（design，仅 `planned_command`） |
| `docs/design/teams-acp-daemon-config-v4.md` | 记录集成状态、计划树为外部受控输入、`--serve` 依赖边界 |
| `.appsdk/guidance/compiled.json` | 官方 `appsdk guide compile` 的派生输出；仅 `AGENTS.md` source digest 与 `manifest_hash` 变化 |

## 证据

命令均在候选 worktree 根目录执行。

| gate | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install --frozen-lockfile` | exit 0 |
| 定向测试 | `pnpm exec vitest run config/ control-protocol/` | 17 files / 151 tests passed |
| 类型检查 | `pnpm exec tsc --noEmit` | exit 0 |
| runtime 契约构建 | `pnpm build:runtime` | exit 0；`generated/runtime-lib/{config,control-protocol}` 产出 D00 契约 |
| map JSON 与交叉引用 | `python3 -c "json.load(...)"` 五张 map + required_gates/planned_bindings 引用检查 | 全部解析成功；无悬空 gate 或 chain 引用 |
| AppSDK guidance | `appsdk guide compile` | exit 0；重写 `.appsdk/guidance/compiled.json`（见下） |
| AppSDK compile | `appsdk compile` | BLOCKED（环境）：exit 1，`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014:required_binary=appsdk-0.1.0014` |
| AppSDK verify | `appsdk verify` | BLOCKED（环境）：exit 1，同一 pin mismatch |

`.appsdk/guidance/compiled.json` 是 `appsdk guide compile` 生成的派生 manifest。因为
`AGENTS.md` 是 `project.json` 声明的 `project-agents` rule source，它的 digest 从
`sha256:f2cb9dc5…` 变为 `sha256:0fbab795…`，`manifest_hash` 随之更新。该文件是
derived output，不是第二个真源；未手工编辑 `.appsdk` 任何其他文件，也未改 SDK 状态、
`project.json`、goal 或 SDK-owned maps。若不随候选提交，工作树会在每次
`appsdk guide compile` 后变脏。

## `--serve` 结论：INCOMPLETE（不做伪接线）

`agentteams --serve <opencode|dsh> --ip --port` 的 runtime 启动不能在本交付独立完成，
它依赖下游交付：

- `cli/agentteams.mjs` 与 `runtime/**` 中不存在任何 `--serve` 实现（grep 无匹配）。
  真实探测：`node cli/agentteams.mjs --serve opencode --ip 127.0.0.1 --port 4300`
  → `unknown command: --serve`，exit 1。这是显式拒绝，不是成功。
- 启动一个引擎 daemon 需要 D01 的 stdio ACP adapter（`acp-adapter/**` 仍为 design
  module，目录不存在）与 D02/D03 的引擎 adapter 和 CLI 实际入口。
- 配置指向注册服务器时还需要 D04 的注册实现；`runtime/agent-daemon.ts` 的
  `startAgentDaemon` 需要 `RelayClientOptions`，不是 v4 intent 的消费者。

D00 可独立完成的是契约面（`parseDaemonConfigText` → `applyDaemonCliOverrides` →
`resolveDaemonIntent` → `compileDaemonIntent` → `readDaemonEffectiveConfig`），已在
`config/daemon-intent.ts` 实现并有测试。但用户入口语义是“启动一个 daemon”，只编译
不启动会成为伪入口，因此本次不接线，`teams-acp-serve-entry` 保持 `design` +
`planned_command`。可执行下一步：D01/D02/D03 提供真实启动后，由主集成单 writer 接线
并用 `teams-acp-serve-entry` 的检查项验收。

## 未完成 / 缺口

1. `--serve` CLI/runtime 接线 INCOMPLETE，owner = 主集成单 writer，依赖 D01/D02/D03（+D04）。
2. `appsdk compile` 与 `appsdk verify` 被环境 pin mismatch 阻断，owner = AppSDK 工具链；
   本候选不改 `.appsdk` 契约，故不影响其结论。
3. ACP 计划树（`docs/goals/teams-acp-network-delivery.md`、任务文件、
   `docs/design/teams-acp-daemon-v1.md`）仍只在计划 owner 的 worktree，未入库。因此根
   `AGENTS.md`、开发管控和长程入口按标题与任务编号引用该外部受控输入，不建相对链接。
   建议由计划 owner 在 D08 前入库，或在授权后由主集成导入；本候选未导入，避免覆盖
   他人未提交产物。
4. 本候选未执行全量 `node scripts/regression.mjs` 的最终结论（后台运行中）；
   定向 D00 gate、类型检查、runtime 构建与 AppSDK guidance 已在本候选上执行。
5. 未 push、未合并 main；review 与集成由主集成编排决定。

## 资源

- 本任务独占 worktree：`/Volumes/Intel/playground/agentteams/acp-d00-integration-20261010`，
  branch `codex/acp-d00-integration-20261010`，owner = 本 worker。
- Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d00-integration-20261010/`。
- 未删除或改动他人 worktree、旧 ACP 材料或共享 base；无保留中的清理义务。
