# D03 主集成绑定 — receipt

日期：2026-10-11，America/Los_Angeles。
候选分支：`codex/acp-d03-bind-20261010`（不 push、不合并 main）。
Base：`origin/main@a8e533d`（D00 `f4783fb` + D01 `7d0bca4`/`75a6cf4` + D01 绑定 `48ce0c9` +
D04 `31db4ce` + D04 绑定 `a8e533d`）。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d03-bind-20261010`（clean、独占）。
Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d03-bind-20261010/`。
本 receipt 由它自己所在的治理提交携带，因此它不能位于它所绑定的那个提交里。

## 1. 绑定的已审候选（冻结，不改写）

| 提交 | 角色 | 说明 |
| --- | --- | --- |
| `aafd2f8` | D03 功能提交（第 1 轮） | 分支 `codex/acp-d03-worker-20261010`，base `75a6cf4`。DSH 引擎 adapter、native config 派生与真实引擎证据 driver |
| `60bf76b` | D03 冻结 HEAD（第 2 轮） | 在 `aafd2f8` 上收口 cleanup 缺陷并加固 native-policy 探针；**tree `ba89d283`**。本轮绑定它 |
| `8197fba` | 本次 cherry-pick（= `aafd2f8` 内容） | 落在 `a8e533d` 上；只冲突 `tsconfig.runtime.json`，按 union 解决 |
| `dbc0585` | 本次 cherry-pick（= `60bf76b` 内容） | 只改 `dsh-adapter/real-engine-evidence.mjs`；无冲突 |

**冻结与历史改写警告（记录，不是本轮所为）。** D03 worker receipt §9.8 的 reflog 显示，
在 D03 worker 提交 `dc5867b` 之后，一个并发 actor 把它 amend 两次
（`dc5867b` → `f89d897` → `60bf76b`）。D03 worker 自己没有 amend/rebase/force。
本轮把 `60bf76b` 当作冻结输入，只做 cherry-pick，不 amend、不改写该分支。

## 2. Review 历史（事实）

- Lead 转达的独立 review 结论：**adapter core PASS**（尊重冻结端口、28/28 定向 spec、
  mutation-verified 断言、真实 DSH 0.2.0-rc.2 推理 18/18 已独立复现）；但
  **D03 milestone closure FAILED**，原因是 `--serve dsh` 不存在、map 与 `.appsdk` 绑定缺失。
- review 报告本身不在本 worktree；D03 worker receipt §9 记录了同一 FAIL-for-closure 结论与
  第 2 轮修复。独立复现的完整真实引擎日志保留在 D03 worker run notes
  （`evidence/logs/round3-real-engine.log`，18 gate + `resource.cleanup`）。
- 本轮**不重做代码 review**；本轮只交付冻结代码、缺失的绑定与集成收口，并把 D03 保持
  `partial`，不升级为 passed/implemented。
- review 提出的两个真实行为问题在 §7 以“带 owner 的已知行为”记录，不当作静默缺口。

## 3. 本次集成交付（唯一 writer）

D03 源码保持冻结候选内容不变；本轮只做合并、union 构建闭包、绑定与证据。

| 文件 | 变更 |
| --- | --- |
| `dsh-adapter/{index,native-config}.ts`、两个 `.spec.ts`、`real-engine-evidence.mjs` | 从 `60bf76b` cherry-pick 引入，逐字节一致（§4 保真证明） |
| `tsconfig.json` | union：`include` 增 `dsh-adapter/**/*.ts` |
| `tsconfig.runtime.json` | union：在 `acp-adapter/stdio.ts` 之后插入 `dsh-adapter/index.ts`、`dsh-adapter/native-config.ts`；保留 D01/D04 全部条目，42 项、无重复、无删除 |
| `vitest.config.ts` | union：`test.include` 增 `dsh-adapter/**/*.spec.ts` |
| `.appsdk/project.json` | `modules[teams-source]` 的 `owned_paths` 与 `regression.input_paths` 都加入 `dsh-adapter/**`（此前 `dsh-adapter` 是未分类产品源码）；`minimum_test_count` 保持 304 |
| `docs/architecture/module-registry.json` | 新增 `dsh-adapter` 模块（owner `dsh-adapter`，status `partial`，owned/forbidden paths，note 含真实引擎证据与 NOT-proven 清单）；修正 `acp-adapter` note 中已过期的“DSH adapter 不存在”措辞 |
| `docs/architecture/verification-map.json` | 新增 required gate `teams-acp-d03-dsh`（owner `dsh-adapter`，status `partial`），`command` = `pnpm exec vitest run dsh-adapter --no-file-parallelism`；真实引擎 driver 作为**声明的本地非 CI check** 写进 `checks` 与 note；修正 D00/D01 两条过期 note；`teams-acp-serve-entry` note 更新为仍缺 D02 与 `--serve` 调用方 |
| `docs/architecture/function-map.json` | 新增 4 个 D03 函数绑定（native config 派生、launch 编译、effectiveness 验证、declared policy keys），各一个 owner、paths 与新 gate；修正 D01 两条过期 note |
| `docs/architecture/mainline-call-map.json` | 新增 `acp-dsh-engine-v1` 链（partial，从**未来** `--serve dsh` 入口到 `dsh-adapter/index.ts`）+ 3 条 owner 边 + 2 条 planned binding；`acp-serve-entry-v1` 保持 `design` 并更新依赖措辞；修正 `acp-host-wiring-v1`、`daemon-config-compile-v1` 的过期措辞 |
| `docs/architecture/resource-map.json` | 只修正三处被本次合并证伪的过期措辞（`daemon-intent-config`、`engine-adapter-port`、`acp-frame-contract`）；不新增资源、不改 owner |
| `docs/development-governance.md` | D03 gate 行 + D03 段落（含 partial 理由、两个已知行为与 `.appsdk/project.json` 的 `dsh-adapter/**` 准入） |
| `docs/evidence/acp-d03-integration-20261010/notes.md` | 本 receipt |

**未在 `docs/architecture/resource-map.json` 新增 D03 资源条目**：沿用 D01/D04 绑定提交的既有
理由——D03 的新真源（DSH 原生 profile patch 派生、engine callback 声明、effectiveness 读回）
已由 function-map 与 mainline-call-map 各记录一次；按“同一事实不跨 map 重复”的约定，不在
resource-map 再建平行条目。本轮只在该 map 修正了三处被本次合并直接证伪的过期措辞
（`daemon-intent-config`、`engine-adapter-port`、`acp-frame-contract` 的“尚无实现/传输”），
不新增资源、不改 owner。

**未实现 `--serve dsh`（本轮明确不做）**。`--serve` 入口由后续 worker 在并发 D02 serve 接线
落地后拥有；本轮不进入 `cli/**`，不新增第二个 writer，也不加只编译不启动的伪入口。
`acp-serve-entry-v1` 与 `teams-acp-serve-entry` 都保持未接线/`design`。

## 4. 合并与 union 解决

```
git worktree add -b codex/acp-d03-bind-20261010 <path> a8e533d
git cherry-pick 75a6cf4..60bf76b
# CONFLICT (content): Merge conflict in tsconfig.runtime.json   ← 唯一冲突，与预期一致
```

解决方式：取 `a8e533d` 的 `include` 数组（40 项，含 D01 的 `acp-adapter/stdio.ts`、
`agent-host/acp-host.ts`、`runtime/acp-{history-store,daemon}.ts` 与 D04 的
`network/registration-client.ts`、`server/registry-intent.ts`、
`runtime/registry-{process,registration}.ts`），把 D03 的两项
`dsh-adapter/index.ts`、`dsh-adapter/native-config.ts` 插在 `acp-adapter/stdio.ts` 之后，
得到 **42 项、unique 42、无重复、无删除**。`tsconfig.json` 与 `vitest.config.ts` 为纯追加行，
Git 自动合并无冲突。

保真证明（本轮必须为空）：

```
git diff --stat 60bf76b -- dsh-adapter/
→ 空输出（5 个 D03 文件与冻结候选 tree `ba89d283` 逐字节一致）
```

union 与 union 后构建闭包核对：

```
node -e '…JSON.parse(tsconfig.runtime.json)…'
→ count 42 / unique 42；missing from union: []；dsh present: true；union == main 的 40 项 + 2 项 D03
pnpm build:runtime
→ exit 0，且 generated/runtime-lib 同时含 D01、D03、D04 的编译产物：
   acp-adapter/stdio.js、agent-host/acp-host.js、runtime/acp-{history-store,daemon}.js、
   dsh-adapter/{index,native-config}.js、network/registration-client.js、
   server/registry-intent.js、runtime/registry-{process,registration}.js
```

## 5. D03 自有缺陷（已由冻结候选修复，本轮只验证）

**缺陷：adapter 必须声明 `callback:session/request_permission`。** 第一次真实引擎运行在
history 里出现 `callback.denied`，workspace 外写入失败。根因：冻结的
`extractAcpCapabilities`（`config/acp-policy.ts`）只从 adapter 自己的声明生成 `callback:` 键，
而 ACP `initialize` 结果无法广告 client method；没有声明时 host 在任何 controller 看到之前
就以 `UNSUPPORTED_METHOD: callback:session/request_permission` 拒绝。修复在 adapter 内部
（`DSH_ENGINE_CALLBACKS` 声明），因为 DSH 专属 engine-callback 知识归 adapter 所有。
这与 D02 的同类 finding 一致（D02 也在 adapter 内声明同一 callback）。

本轮验证：`dsh-adapter/index.spec.ts` 的
`declares the engine approval callback so the frozen policy admits it` 通过；真实引擎重跑中
`adapter.compileLaunch` 的 `supportedPolicies` 含 `callback:session/request_permission`，
`history.readback` 出现 `callback.dispatched` 与 `callback.reply`，`native.policy` 的
option ids 为引擎自己的 `["allow-once","reject-once"]`。
**本轮未改 `dsh-adapter/*.ts` 语义**（§4 保真证明）。

## 6. 清理缺陷历史（记录，不复现）

第 1 轮 driver 在 `fail()` 里先调用 `finish(1)`，而 `resource.cleanup` 块在脚本末尾，因此只有
成功路径执行清理：每次失败或中断的运行都会泄漏真实 DSH engine home，并可能留下引擎子进程。
**六个真实 engine home 泄漏**（`E6uDSS`、`ZaKDzo`、`aPy9qs`、`l8sxb9`、`qN4B2O`、`u3BEcz`）。
第 2 轮（`60bf76b`）把它修成单一 `finish()` 漏斗：先 stop 仍存活的 child，再删 owned work
root（除非 `--keep`），把真实结果记为 `resource.cleanup` gate，清理失败即使功能 gate 全过也
以非零退出；`SIGINT`/`SIGTERM`/`SIGHUP`、`uncaughtException`、`unhandledRejection` 都走同一
漏斗；`--fail-gate <gate>` 用于在故意失败的运行上证明清理路径。六个泄漏 home 已按显式路径
逐一核对后删除，D03 worker receipt §7/§9.3–§9.5 已更正原错误的“已由 driver 清理”表述。
本轮重跑再次确认清理成立（§8）。D03 worker 第 1 轮 receipt 的该行是**已更正的错误陈述**，
不是隐藏的静默缺口。

## 7. 两个已知行为与 owner（记录，不静默）

- **KB-1 — DSH `embeddedContext:false` 与 `resource_link` 冻结策略冲突。**
  真实 DSH `initialize` 广告 `promptCapabilities.embeddedContext = false`（本轮重跑再次观测到）；
  冻结 D01 策略 `assertPromptModalities` 对 `resource_link` 提示要求
  `capability:/promptCapabilities/embeddedContext`。后果：`resource_link` 提示在真实 DSH 上不被
  准入。**owner：Lead（policy 决策）；DSH engine（广告值）**。D03 不得改
  `config/acp-policy.ts`（冻结且不在 D03 允许路径内）。
- **KB-2 — `session/list` 在会话仍打开时返回 `[]`。**
  本轮重跑：`listBeforeClose = {count: 0, containsCreated: false}`，
  `listAfterClose = {count: 1, containsCreated: true}`。DSH 的 `session/list` 分页的是
  *已持久化、可 resume 的 root session*。**owner：DSH engine（行为）；D05/D06/D07 消费者
  （不得把它当作 live-session 目录）；Lead（集成说明）**。

## 8. 证据面（分开，命令均在候选 worktree 根目录执行）

| 证据面 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install --frozen-lockfile` | exit 0（pnpm 10.31.0，node v22.22.2） |
| D03 定向 suite | `pnpm exec vitest run dsh-adapter --no-file-parallelism` | **28/28 PASS**，2 files（index 23、native-config 5） |
| D01 定向 suite | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts` | **53/53 PASS**，4 files |
| D04 定向 gates | `pnpm exec vitest run --no-file-parallelism server/relay.spec.ts network/registration-client.spec.ts server/registry-intent.spec.ts` | **40/40 PASS**，3 files（relay 29、registration-client 6、registry-intent 5） |
| 类型检查 | `pnpm typecheck` | exit 0（root tsc + opencode-adapter build/typecheck + console-host + ui/teams-console） |
| runtime 构建 | `pnpm build:runtime` | exit 0；同时产出 D01/D03/D04 编译产物（§4） |
| 真实引擎（本轮重跑） | `pnpm build:runtime && node dsh-adapter/real-engine-evidence.mjs --config <run>/evidence/d03-dsh.toml --receipt <run>/evidence/logs/real-engine-receipt.json` | **18/18 PASS**，exit 0；真实 dsh 0.2.0-rc.2、真实 `~/.dsh` 凭据引用 `DEEPSEEK_FLASH_API_KEY`、真实 D01 runtime；`resource.cleanup` PASS，`engineHomeRemoved:true`，无泄漏 |
| 五张 map 校验 | `python3 .worker-runs/acp-d03-bind-20261010/validate-maps.py` | **PASS**：五张 map parse OK、duplicate_keys=none、无悬空 `required_gates`；新 gate 恰好出现 1 次 |
| 冻结保真 | `git diff --stat 60bf76b -- dsh-adapter/` | 空输出 |
| Review | Lead 转达的独立 review | adapter core **PASS**；milestone closure **FAILED**（缺 `--serve dsh` 与 map/.appsdk 绑定） |
| Merge/集成 | 本 receipt 所在提交 | cherry-pick `8197fba` + `dbc0585` + 治理提交 |
| AppSDK compile/verify | `appsdk compile` / `appsdk verify` | **BLOCKED（环境，未运行）**：沿用 D01/D04 记录的既有 `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014`（本机 appsdk 0.1.8） |

真实引擎重跑在提交前的工作树上执行；该工作树的源码（`dsh-adapter/**`、`runtime/**`、
`config/**`、`control-protocol/**`）与提交候选逐字节一致（本治理提交只含 `.appsdk/**` 与
`docs/**`；`tsconfig`/`vitest` 的构建闭包行在 cherry-pick 提交 `8197fba` 中），因此该证据
绑定的是同一源码候选。

真实引擎本轮关键观测（`evidence/logs/real-engine-receipt.json`）：

- `adapter.compileLaunch`：`supportedPolicies=["acp","method:session/set_config_option","callback:session/request_permission"]`，`credentialEnvRefs={"TEAMS_DSH_CREDENTIAL_0":"DEEPSEEK_FLASH_API_KEY"}`，patch 文件 mode `384`（`0600`）。
- `channel.initialize`：`agentInfo={name:"deepseek-harness-acp",version:"0.0.1"}`，`promptCapabilities={image:false,audio:false,embeddedContext:false}`，`sessionCapabilities={close,list,resume}`。
- `session/new`：真实 session id，`model.currentValue = "[\"teams-workbuddy\",\"wb-deepseek-v4.1-flash\"]"`（派生路由，非 DSH 默认）。
- `session/prompt`：真实推理 `stopReason=end_turn`、assistant text `DSH-ACP-OK`。
- `native.policy`：workspace 内写入 `created:true`；workspace 外写入由真实 `session/request_permission` 回调门控，option ids `["allow-once","reject-once"]`，controller 允许后写入才落地。
- `native.policy.reject`：`created:false`，拒绝的 gated 写入从未落地。
- `history.readback`：73 records，事件含 `callback.dispatched`、`callback.reply`、`cancel.requested`、`result.received`。
- `dsh.home`：`DSH_HOME` 拥有 `profiles/acp/{cordis.yml,cordis.patch.yml,package.json,pnpm-workspace.yaml}`、`sessions/` 与 patch 文件；未写用户真实 `~/.dsh`。
- `resource.cleanup`：`engineHomeRemoved:true`，work root 已删除；扫描无残留 `d03-real-engine-*`，`~/d03-{outside,rejected}-probe.txt` 不存在。

## 9. map 校验命令与结果

脚本：`.worker-runs/acp-d03-bind-20261010/validate-maps.py`（含重复键 hook 与交叉引用解析）。
实测输出（`evidence/logs/validate-maps.log`）：

```
function-map.json: parse OK, duplicate_keys=none
mainline-call-map.json: parse OK, duplicate_keys=none
module-registry.json: parse OK, duplicate_keys=none
resource-map.json: parse OK, duplicate_keys=none
verification-map.json: parse OK, duplicate_keys=none
required_gates dangling: none
edges with an undeclared chain_id (advisory, pre-existing): ['endpoint-discovery-admission-v1', 'session-control-v1']
teams-acp-d03-dsh occurrences in verification-map: 1
RESULT: PASS
```

- 新增 gate `teams-acp-d03-dsh` 在 `verification-map.json` 只出现一次；全部 `required_gates`
  引用（含新增 4 个 function binding 与 `acp-dsh-engine-v1` 的 2 条 planned binding）可解析。
- **既有悬空（非本次引入）**：`edges` 中 2 个 chain_id 只在边里出现、未在 `chains` 声明
  （`endpoint-discovery-admission-v1`、`session-control-v1`）。D04 绑定 receipt §7 已在
  `48ce0c9` 上记录同一集合；本轮未新增也未修复，修复涉及 endpoint/session-control owner，
  超出 D03 绑定范围。

## 10. 明确 NOT proven（不得从前一层推断）

1. **无 `--serve dsh` 入口**。本轮明确不实现；`cli/**` 未改，`acp-serve-entry-v1` 与
   `teams-acp-serve-entry` 保持未接线/`design`。后续 worker 在并发 D02 serve 接线落地后拥有该入口。
2. **无安装副本 / live 产品证据**。没有 npm pack/install、installed CLI replay、daemon
   start/restart 或 `--serve` 真实启动；真实引擎证据来自**已提交的 evidence driver**，不是
   产品入口。
3. **AppSDK gate 被环境阻断**（§8），本轮不把该 gate 记为通过。
4. **全量 `pnpm test` 未在本候选重跑**。D03 worker 记录的既有 load-sensitive 失败
   （`runtime/agent-process.spec.ts`、`runtime/managed-opencode-session.spec.ts`）在 base
   `75a6cf4` 上已存在，候选失败集合是基线的子集；本轮只跑定向 gates，不宣称全量回归通过。
5. **真实引擎证据覆盖一个 provider 协议**（`openai-responses` 经 proxy route）。
   `openai-chat` → `openai-completions` 映射由 focused spec 覆盖，未由已提交 driver 运行覆盖。
6. **两个已知行为仍开放**（§7）：`resource_link` 提示准入（Lead policy 决策）与
   `session/list` 语义（D05/D06/D07 消费者约束）。
7. **一处更早期的过期措辞未改**：`docs/design/teams-acp-daemon-config-v4.md` 头部仍写 D00
   范围的“运行实现仍 pending”；超出 D03 绑定范围，留给对应文档 owner。D03 修正的是本次
   合并直接使其为假的多条 map note（D00 daemon-intent、D01 host、acp-adapter 模块、
   agent-host/cli-facade 模块、`engine-adapter-port`、`daemon-config-compile-v1` 等），
   不重写与本次变更无关的历史文本。

## 11. 未完成的绑定 / 缺口与下一步

1. `teams-acp-d03-dsh` 保持 `partial`：缺 `--serve dsh` 入口、安装副本与 live 证据；
   AppSDK 被既有 pin mismatch 阻塞。
2. 下一步（Lead 排程）：等并发 D02 serve 接线落地后，由后续 worker 实现 `--serve dsh` 并
   采集 installed/live 证据；D03 不再进入 `cli/**`。
3. 两个已知行为的决策/记录见 §7（Lead policy 决策；D05/D06/D07 消费者约束）。
4. 第 9 节的 2 个既有悬空 `chain_id` 仍未修复。
5. 未 push、未合并 main；由主集成编排决定后续。

## 12. 资源

- 独占 worktree：`/Volumes/Intel/playground/agentteams/acp-d03-bind-20261010`，
  branch `codex/acp-d03-bind-20261010`，owner = 本 worker；保留到主集成完成 review/merge/
  远端 receipt 后回收。
- Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d03-bind-20261010/`
  （`validate-maps.py`、`evidence/d03-dsh.toml`、`evidence/workspace/`、
  `evidence/logs/{real-engine.log,real-engine-receipt.json,validate-maps.log}`）。
- 真实引擎运行创建并移除了自己的临时 work root（`/var/folders/.../T/d03-real-engine-Dq2c8l`）；
  运行后扫描无残留 `d03-real-engine-*`，`~/d03-{outside,rejected}-probe.txt` 不存在。
  引擎子进程以显式 PID 核对已退出；未使用 `pkill`/`killall`。
- 未删除或改动他人 worktree、他人 run notes 与共享 base（含冻结分支
  `codex/acp-d03-worker-20261010`）。
