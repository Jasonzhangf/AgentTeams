# D01 主集成治理绑定 — receipt

日期：2026-10-11，America/Los_Angeles。
候选：`codex/acp-d01-bind-20261010`。
Base：`origin/main@75a6cf4`（D00 `f4783fb` + D01 `7d0bca4` + review 修复 `75a6cf4`）。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d01-bind-20261010`（clean、独占）。
Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d01-bind-20261010/`。
本 receipt 由它自己所在的治理提交携带，因此它不能位于它所绑定的那个提交里。

## 1. 绑定的已合并提交

| 提交 | 角色 | 说明 |
| --- | --- | --- |
| `7d0bca4` | D01 功能提交 | 引擎无关 ACP stdio adapter、agent-host Session/policy/history host、runtime daemon 与 history store，加三行共享构建闭包（`tsconfig.json`、`tsconfig.runtime.json`、`vitest.config.ts`） |
| `75a6cf4` | D01 review 修复提交 | 修复 review 的 B1（失败启动泄漏引擎子进程且 `cleanup: null`）与 B2（notification 形式 `initialize` 被转发给引擎），并附两条新断言 |

`git log --oneline` 顺序为 `75a6cf4` → `7d0bca4` → `f4783fb`（D00 receipt）→
`9070c45`/`9a511de`/`8c17479`（D00）。集成前 `main == origin/main == 75a6cf4`；本次
候选从该提交建立独占 worktree，不 push、不合并 main、不改写历史。

## 2. Review 历史（事实）

- `7d0bca4` 的独立 review 结论为 **FAIL**，含两个必须修复项：
  - **B1**：`startAcpEngineHandle` 在 `createStdioAcpDuplex` 校验 `maxFrameBytes`/
    `readTimeoutMs` 之前就已 spawn 子进程；duplex 抛错走到外层 catch，返回
    `{ kind: 'failed' }` 却不杀子进程，`startAcpAgentDaemon` 随后返回
    `cleanup: null`。
  - **B2**：`receiveClientNotification` 对 `method === 'initialize'` 落到
    `notification.dispatched` 与 `acp.send(frame)`，通知形式可以重新初始化子进程。
- 修复提交 `75a6cf4` 针对两个 blocker 做定向复核，结论 **PASS**（两个 blocker 均
  已修复并有断言覆盖）。修复方式与红测证据见 D01 worker receipt 第 9 节
  （`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d01-worker-20261010/receipt.md`）。
- 本 receipt 只记录该 review 历史；本次治理候选不重做代码 review，也不改 D01 源码。

## 3. 本次治理/证据交付（唯一 writer）

只改治理与证据路径，不动 `acp-adapter/`、`agent-host/`、`runtime/`、`network/`、
`server/`、`config/`、`control-protocol/`、`cli/`、`ui/` 任何源码。

| 文件 | 变更 |
| --- | --- |
| `.appsdk/project.json` | `teams-source` 的 `owned_paths` 与 `regression.input_paths` 各加 `acp-adapter/**` 与 `cli/**`；`minimum_test_count` 保持 304 未改 |
| `docs/architecture/verification-map.json` | 新增 `teams-acp-d01-host`（owner `agent-host`，`required: true`，`status: partial`），命令为 D01 定向 suite，检查项对应真实断言，note 说明仍缺什么 |
| `docs/architecture/module-registry.json` | `acp-adapter` 与 `agent-host` 从 `design` 移到诚实的 `partial`，修掉 “acp-adapter 目录尚不存在” 的过期 note |
| `docs/architecture/function-map.json` | 新增 4 个 D01 函数绑定（adapter 传输、host 语义、history store、daemon 接线），各一个 owner、paths 与新 gate |
| `docs/architecture/mainline-call-map.json` | 新增 `acp-host-wiring-v1` 链（partial）及 3 条 owner 边与 3 条 planned binding；`acp-serve-entry-v1` 保持 `design` |
| `docs/development-governance.md` | D00 gate 表旁新增 `teams-acp-d01-host` 行并说明 partial 理由；修正 AppSDK 输入段 |
| `docs/evidence/acp-d01-integration-20261010/notes.md` | 本 receipt |

**未改动**：`docs/architecture/resource-map.json`。D01 的新真源（stdio duplex、
history store、daemon 句柄）已由 function/mainline 两个 map 记录一次；按 “同一事实
不跨 map 重复” 的既有约定，未在 resource-map 再建一条平行记录。若后续需要，resource
绑定应由唯一 owner 在下一轮按需补，不在本候选猜测。

**未改动 `AGENTS.md`**：D01 未改变项目事实边界（新目录仍由既有 `teams-source` 模块
与五张 map 承载），因此无需改 `AGENTS.md`，也就无需重跑 `appsdk guide compile`；
`.appsdk/guidance/compiled.json` 未变（其两个 source digest 仍是
`AGENTS.md` 与 governance Skill）。

## 4. 证据（区分来源）

命令均在候选 worktree 根目录执行。

| 证据面 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install --frozen-lockfile` | exit 0（pnpm 10.31.0，node v22.22.2） |
| D01 定向 suite | `pnpm exec vitest run acp-adapter agent-host/acp-host.spec.ts runtime/acp-history-store.spec.ts runtime/acp-daemon.spec.ts` | **53/53 PASS**，4 files，2.09s（stdio 15、host 19、store 8、daemon 11） |
| 类型检查 | `pnpm typecheck` | exit 0（root `tsc --noEmit` + opencode-adapter + console-host + ui/teams-console） |
| runtime 构建 | `pnpm build:runtime` | exit 0；重生成 `generated/runtime-lib`（含 `acp-adapter/stdio`、`agent-host/acp-*`、`runtime/acp-*`） |
| map JSON 解析与交叉引用 | `python3` 五张 map 解析 + 重复键检查 + `required_gates`/`chain_id` 引用解析 | 全部通过（见第 5 节命令与结果） |
| AppSDK compile | `appsdk compile` | **BLOCKED（环境）**：exit 1，`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014:required_binary=appsdk-0.1.0014`；本机 `appsdk` 为 v0.1.8（`~/.cargo/bin/appsdk`） |
| AppSDK verify | `appsdk verify` | **BLOCKED（环境）**：exit 1，同一 pin mismatch（另有既有 legacy migration warning） |
| 全量 `pnpm test` | 未在本治理候选重跑 | 见第 6 节 NOT proven；D01 worker receipt 记录 874 passed / 2 failed 的既有 load-sensitive 失败 |

这些是**源码/测试/类型/构建**证据。它们不是安装副本、restart、live daemon 或真实
引擎推理证据；本候选没有执行任何安装、重启或 live replay。

## 5. map 校验命令与结果

实际执行的校验脚本（结果在下方）：

```python
import json
from pathlib import Path

MAPS = ["function-map", "mainline-call-map", "module-registry", "resource-map", "verification-map"]
loaded = {}
for name in MAPS:
    raw = Path(f"docs/architecture/{name}.json").read_text()
    dups = []
    def hook(pairs):
        seen = set()
        for k, _ in pairs:
            if k in seen:
                dups.append(k)
            seen.add(k)
        return dict(pairs)
    loaded[name] = json.loads(raw, object_pairs_hook=hook)
    print(f"{name}: parse OK, duplicate_keys={dups if dups else 'none'}")

vm = loaded["verification-map"]
gate_set = {g["gate_id"] for g in vm["gates"]}
fm = loaded["function-map"]
mc = loaded["mainline-call-map"]
chains = {c["chain_id"] for c in mc["chains"]}
print("function-map dangling required_gates:",
      [(f["function_id"], g) for f in fm["functions"] for g in f.get("required_gates", []) if g not in gate_set] or "none")
print("mainline dangling refs:",
      [(e["chain_id"]) for e in mc["edges"] if e["chain_id"] not in chains] or "none")
```

实测结果：

```
function-map: parse OK, duplicate_keys=none
mainline-call-map: parse OK, duplicate_keys=none
module-registry: parse OK, duplicate_keys=none
resource-map: parse OK, duplicate_keys=none
verification-map: parse OK, duplicate_keys=none
verification-map: 70 gates, all unique
function-map dangling required_gates: none
mainline dangling refs: [('edge','endpoint-discovery-admission-v1'), ('edge','session-control-v1'), ('edge','session-control-v1'), ('edge','session-control-v1')]
module-registry: 20 modules, all unique
  agent-host: status=partial
  acp-adapter: status=partial
teams-acp-d01-host referenced: True
```

交叉引用解析：

- `verification-map.json` 的 70 个 `gate_id` 全部唯一；新增 `teams-acp-d01-host` 只出现一次。
- `function-map.json` 的每个 `required_gates` 条目都能在 `verification-map.json` 找到同名
  gate（含新 gate）；无悬空引用。
- `mainline-call-map.json` 的每条 `planned_bindings` 的 `chain_id` 与 `required_gates`
  都能解析（含新链 `acp-host-wiring-v1`）。
- `module-registry.json` 的 20 个 `module_id` 唯一；`acp-adapter` 与 `agent-host` 各一条。
- **既有悬空（非本次引入）**：`edges` 中有 4 条引用了只作为边存在、未在 `chains` 声明的
  chain_id —— `endpoint-discovery-admission-v1`（1 条）与 `session-control-v1`（3 条）。
  用 `git show HEAD:docs/architecture/mainline-call-map.json` 复算，集成基线
  `75a6cf4` 上同样存在这 4 条，本次变更未新增也未修复它们。修复需要为这两条既有链补
  `chains` 声明（涉及 endpoint/session-control owner），超出本次 D01 绑定范围，故作为
  既有缺口记录，不猜测补写。

## 6. 明确 NOT proven（不得从前一层推断）

1. **无真实引擎推理**。D01 只用标注的 `acp-adapter/test-peer.mjs` 证明传输与 host
   语义；没有 OpenCode/DSH adapter 编译真实 `EngineLaunchSpec`，没有一次真实模型推理。
2. **无安装副本/live 证据**。没有 npm pack/install、没有 installed CLI 入口 replay、
   没有 daemon start/restart、没有 `--serve` 真实启动；`teams-acp-serve-entry` 仍
   `design`。
3. **AppSDK gate 被环境阻断**。`appsdk compile`/`appsdk verify` 因 pin mismatch
   （项目 pin `0.1.0014`，本机 `0.1.8`）失败；本候选不改 `.appsdk` 契约状态，也不把
   该 gate 记为通过。
4. **全量 `pnpm test` 有既有 load-sensitive 失败**，未在本候选重跑：D01 worker
   receipt 记录 92 文件 874 passed / 2 failed / 0 pending，失败为
   `runtime/agent-process.spec.ts` 与 `runtime/managed-opencode-session.spec.ts`，
   在 `--no-file-parallelism` 下通过，均非 D01 代码。本候选不宣称全量回归通过。
5. **network/server/UI/CLI `--serve`、D05 连接协商、D06 history 读取**均未实现。
6. **`cli/**` 已准入但无新增源码**：本次只把 `cli/**` 加入 SDK owned/regression 输入，
   没有改 `cli/agentteams.mjs` 或它的 spec；D04 将在该目录写入。

## 7. 未完成的绑定 / 缺口

1. `teams-acp-d01-host` 保持 `partial`：真实引擎、安装与 live 证据缺失，owner =
   后续 D02/D03/D04 与主集成；可执行下一步是安装 pin 匹配的 `appsdk-0.1.0014` 并跑
   `appsdk compile && appsdk verify`。
2. `docs/architecture/resource-map.json` 未加 D01 资源条目（见第 3 节理由）。
3. `minimum_test_count` 保持 304：D01 receipt 记录全量 874 passed，远高于 304；本次
   治理变更不改变真实测试计数，因此不调整阈值，避免无依据的数字。
4. 未 push、未合并 main；review 与集成由主集成编排决定。

## 8. 资源

- 独占 worktree：`/Volumes/Intel/playground/agentteams/acp-d01-bind-20261010`，
  branch `codex/acp-d01-bind-20261010`，owner = 本 worker；保留到主集成完成 review/
  merge/远端 receipt 后回收。
- Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d01-bind-20261010/`。
- 未删除或改动他人 worktree、旧 ACP 材料或共享 base；测试子进程由 spec teardown 停止，
  未启动常驻 daemon。
