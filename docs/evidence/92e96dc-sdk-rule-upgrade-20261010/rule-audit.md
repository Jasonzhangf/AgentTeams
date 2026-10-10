# 规则/Skill 升级审计：AgentTeams × AppSDK 0.1.0014

官方只读入口：`appsdk guide init --task guidance-upgrade --mode bootstrap --module teams-source`
返回 `setup_kind=template_upgrade_review`，`readiness=needs_conditional_authorization`，
`writes_state=false`。它要求先读生效上层规则、本地 `AGENTS.md` 与 Skill、实际测试命令
与 CI/hook 行为，再读模板，并对每个差异记录 path、owner、action、basis、保留保障、
受影响入口。

## 已读输入

- 生效上层规则：`.appsdk/rules/appsdk-project-governance.md`（含 0.1.0014 新增
  “Rule and Skill upgrade audit” 一节）、`.appsdk/skills/appsdk-project-governance/SKILL.md`
  与其 references。
- 本地规则：根 `AGENTS.md`（96 行 → 审计后 158 行）、`docs/development-governance.md`
  （120 行 → 审计后 145 行）。
- 本地 Skill：无。仓库没有 `skills/`、`.agents/skills/`、`.codex/skills/` 目录。
- 实际测试命令：根 `package.json` 的 `test`、`typecheck`、`build`、`verify`、`smoke`、
  `smoke:installed`、`lifecycle:admission`、`build:governance`；门禁脚本
  `scripts/regression.mjs`。
- CI/hook 入口：无。没有 `.github/workflows/`、`.husky/`、`.githooks/`，且
  `git config core.hooksPath` 为空。
- 参考模板：`.appsdk/templates/minimal/AGENTS.md`
  （`sha256:bf2b8a63c1b5c54392c68adcd0407446a3e549fb83deda2f7d1d5243d2c9e4ca`，
  version 0.1.0014，enforcement advisory）。

## 差异与处置

| # | 模板位置 | 项目现状 | owner | action | basis | 保留保障 | 受影响入口 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Project Truth：Compatibility and legacy boundaries | `AGENTS.md` 的 Project truth 只有用途与入口，没有兼容/退役边界 | project | add | 模板要求声明兼容与遗留边界；`docs/development-governance.md:60` 记录旧宿主 UI 与空壳准入文件已移除 | 既有 Project truth 条目不动 | `AGENTS.md`（Guidance 声明的 rule source，需 `guide compile`） |
| D2 | Ownership：owner/边界路径/派生真源/复用优先/缺失即显式失败 | `AGENTS.md` 只有 “One feature, resource, and implementation has one owner”，未声明 allowed/forbidden 路径、复用优先与 “missing operator 不得 mock success” | project | merge | 模板这五条是既有不变量的细化；项目已声明 OpenCode config 是派生适配输出 | 既有 owner 不变量与派生真源条目保留 | `AGENTS.md`、`guide compile` |
| D3 | Architecture Truth：只维护需要的 map、不跨 map 重复、缺失归属只阻断受影响变更、map 与 gate 同变更 | `AGENTS.md` 有 “读五张 map” 和 “maps 与 tests 同变更”，但没有 “不重复事实” 与 “缺失归属只阻断受影响变更” | project | merge | 模板要求 map 事实唯一，且归属缺失不扩散为全仓阻塞 | 五张 `docs/architecture/` map 仍是语义 owner；`.appsdk/maps/` 仍属 SDK | `AGENTS.md`、`guide compile` |
| D4 | Development Process Control：Guidance/Memory 辅助、plan 绑定、声明式转移、workflow close 与 lifecycle completion 分离、review 严重度、证据复用、memory 不覆盖规则 | `docs/development-governance.md` 已覆盖证据复用与阶段状态；`AGENTS.md` 未声明 plan 绑定字段、转移纪律、两个 close 的区别、review 只阻断实质回归 | project | merge + narrow | 过程细节已有唯一 owner（`docs/development-governance.md`），只把模板缺的事实与边界补进 `AGENTS.md`，不新建第二套流程 | 现有阶段状态机 `pending→running→passed/blocked/invalidated/reused` 不变 | `AGENTS.md`、`guide compile` |
| D5 | Git Protection：主线只读、clean owner worktree、**配置项目自己的 commit/push 保护**、保护检查只证明 Git 边界、交付与远端回执后才回收 worktree | `AGENTS.md` 有 worktree 与主线不动；没有保护边界声明，也没有 worktree 回收条件 | project | merge + **decline**（钩子部分） | 项目保护是程序性的：候选 gate + 一次 review 后由 primary 集成。SDK 0.1.0014 bundle 不提供 git-protection 命令；`docs/development-governance.md` 声明提交动作不触发整套测试，commit 期钩子会与该风险选择冲突 | 保留 worktree 纪律、禁 `--no-verify`、review 前必须通过验证、远端回执核对 | `AGENTS.md`、`docs/development-governance.md` |
| D6 | Task Routing：项目自有路由表，含可选 memory 检索/晋升 | `AGENTS.md` 的 Canonical surfaces 覆盖需求、架构、SDK、运行时源码，缺 memory 与“事实/过程/机器流程”归属 | project | merge + narrow | 模板要求路由声明；项目没有 project-local Skill，故把 “可复用流程” 收窄到已声明的 `docs/development-governance.md`，不新建 Skill | 既有四个 surface 不变 | `AGENTS.md`、`guide compile` |
| D7 | Evidence Boundary：分级汇报、不跨级推断、阻塞结论字段 | `docs/development-governance.md` 已分级描述产物与证据；没有阻塞结论字段契约 | project | merge | 模板要求阻塞结果给出第一个失败 gate、保留状态、重试策略、owner 与一条可执行下一步 | 既有证据分级与复用规则保留 | `AGENTS.md`、`docs/development-governance.md`、`guide compile` |
| D8 | 模板 setup 占位符（`[describe]` 等） | 项目 AGENTS 已是具体事实 | project | decline | 占位符是模板初始化脚手架，不适用于已建立的契约 | 无 | 无 |
| D9 | 模板 “If this project declares a fixed lifecycle skeleton” | 项目未声明固定生命周期骨架 | project | decline | 条件不成立；不为假设需求引入骨架 | 现有 `teams-source` 生命周期模块与 `.appsdk/` 契约不变 | 无 |
| D10 | SDK 0.1.0014 新增可选 `test_governance`（scoped tests） | `.appsdk/project.json` 未声明 `test_governance`，`appsdk verify` 报 `mode:off, status:not_selected` | project | decline（保持 off） | SDK 明确其为可选：普通 `verify` 只报状态，不要求测试通过。项目已声明自己的全量测试真源（`scripts/regression.mjs`，强制 `minimum_test_count`，拒绝 skip/TODO/`.only`）与安装生命周期 gate；再选 SDK 测试治理会形成第二个重叠的测试真源 | `pnpm verify` 与 `pnpm lifecycle:admission` 不变 | 无 |
| D11 | SDK 0.1.0014 自身用路径选择的 GitHub workflow 做 CI，release 只在 dispatch/tag 上跑 | 项目没有任何 CI 或 hook | project | decline（保持本地门禁） | 项目没有可复现的托管运行环境：门禁需要本机 `appsdk` 二进制、OpenCode 运行时与已安装依赖。加一个跑不起来的 workflow 会产生假的保护证据，违反 “passing protection check proves only the Git boundary”。日常选择由 `docs/development-governance.md` 的命令/证据表声明，全量门禁在发布范围执行 | 本地 `pnpm verify` 与远端回执核对保留 | 无 |

## 应用结果

- `AGENTS.md`：新增 `## Ownership`、`## Architecture truth`、`## Process control`、
  `## Evidence boundary`；Project truth 补兼容边界；Development contract 补 Git 边界与
  worktree 回收条件；删除与 Architecture truth 重复的 map 同变更条目；Canonical
  surfaces 补事实/过程/机器流程归属与 memory 入口。
- `docs/development-governance.md`：新增 “命令、证据与选择粒度” 表与 “阻塞回报” 契约。
- 未改动：任何产品源码、测试、`.appsdk/` 手工内容、CI/hook（项目无 CI/hook）、
  `.appsdk/project.json` 的 guidance 声明与 `test_governance` 选择。

## 授权

`proposal_schema.approval_required = uncovered_durable_changes_only`。本次差异全部落在
用户 “开始治理改造” 的会话授权范围内，且 D1–D7 是把官方模板已生效的规则补齐到项目
自有 owner，D8–D10 是拒绝项。未发现需要额外批准的未覆盖durable 变更。
