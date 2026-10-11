# D04 主集成绑定与 F1 收口 — receipt

日期：2026-10-11，America/Los_Angeles。
候选分支：`codex/acp-d04-bind-20261010`（不 push、不合并 main）。
Base：`origin/main@48ce0c9`（D00 `f4783fb` + D01 `7d0bca4`/`75a6cf4` + D01 绑定 `48ce0c9`）。
Worktree：`/Volumes/Intel/playground/agentteams/acp-d04-bind-20261010`（clean、独占）。
Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d04-bind-20261010/`。
本 receipt 由它自己所在的治理提交携带，因此它不能位于它所绑定的那个提交里。

## 1. 绑定的已审候选

| 提交 | 角色 | 说明 |
| --- | --- | --- |
| `953d952` | D04 功能提交（已审候选） | 分支 `codex/acp-d04-worker-20261010`，base `f4783fb`。LAN registry daemon、presence 租约、自动注册与心跳 |
| `31db4ce` | 本次 cherry-pick 提交 | `git cherry-pick -x 953d952` 落在 `48ce0c9` 上的结果；只解决 `tsconfig.runtime.json` 冲突，D04 内容零语义改动 |

`git log --oneline` 顺序为 `31db4ce` → `48ce0c9` → `75a6cf4` → `7d0bca4` → `f4783fb`。
集成前 `main == origin/main == 48ce0c9`；本次从该提交建独占 worktree，不改写历史。

## 2. Review 历史（事实）

- 独立 review 对候选 `953d952` 的结论为 **PASS**，含一个必须跟进的 finding **F1**。
- 已独立复现的定向门禁：61/61 与 73/73、`cli/agentteams.spec.ts` 26/26、
  `pnpm typecheck` 与 `pnpm build:runtime` PASS、黑盒 14/14 PASS。
- 预测的唯一合并冲突为 `tsconfig.runtime.json`（D01 重写了 `include` 数组，D04 在数组末尾
  追加了单独一行）；实际 cherry-pick 与预测一致，只冲突该文件。
- **F1（本轮必须收口）**：`agentteams registry start --config config/examples/registry.toml`
  以 exit 1 和 `TLS_REQUIRED` 失败。原因是 `server/registry-intent.ts` 即使在 loopback 也要求
  显式 `tlsCertRef`/`tlsKeyRef`，而 D00 示例 `config/examples/registry.toml` 与
  `docs/design/teams-acp-daemon-config-v4.md` §3 的措辞暗示 loopback 可以省略。
- 本轮不重做代码 review，也不改 D04 源码语义；只收口 F1 并做集成绑定。

## 3. 本次集成交付（唯一 writer）

D04 源码文件保持已审候选内容不变；本轮只改示例配置、D00 设计文档的措辞、四张 map、
开发管控与证据。

| 文件 | 变更 |
| --- | --- |
| `config/examples/registry.toml` | F1：补 `tlsCertRef`/`tlsKeyRef`（`file:./certs/registry-cert.pem`、`file:./certs/registry-key.pem`），保持 loopback 与两条 admission；注释记录首次启动前的 `mkdir -p certs` + openssl 命令与两个必需环境值 |
| `docs/design/teams-acp-daemon-config-v4.md` | F1：§3 分别陈述 schema 层与 registry 运行时层的 TLS 规则，点名 owner `server/registry-intent.ts` 与精确 openssl 命令；§9 更新 registry 示例行与首次启动前提及真实失败文本 |
| `docs/architecture/verification-map.json` | 新增 `teams-acp-d04-registry`（owner `runtime`，`required: true`，`status: partial`），命令为 D04 六文件定向 suite，检查项对应真实断言，note 说明仍缺什么 |
| `docs/architecture/module-registry.json` | `server` 加 presence 租约与 registry intent 映射；`network` 新增 note（registration client）；`runtime` 加 registry 生命周期与注册组合；`cli-facade` 加 `agentteams registry start|status|stop` 入口 |
| `docs/architecture/function-map.json` | 新增 5 个 D04 函数绑定（presence 租约、registry intent 映射、registration client、registry daemon 生命周期、注册组合），各一个 owner、paths 与新 gate |
| `docs/architecture/mainline-call-map.json` | 新增 `acp-registry-v1` 链（partial）+ 5 条 owner 边 + 3 条 planned binding；`acp-serve-entry-v1` 保持 `design`，note 更新为“D01/D04 已源码层交付，仍缺 D02/D03 与 `--serve` 调用方” |
| `docs/development-governance.md` | D04 gate 行 + D04 段落（含 partial 理由与 `.appsdk/project.json` 无需改动的理由） |
| `docs/evidence/acp-d04-integration-20261010/notes.md` | 本 receipt |

**未改动 `docs/architecture/resource-map.json`**：沿用 D01 绑定提交 `48ce0c9` 的既有理由——
D04 的新真源（registry 生命周期状态文件、presence 租约、registration client 健康状态）已由
function-map 与 mainline-call-map 各记录一次；按“同一事实不跨 map 重复”的约定，不在
resource-map 再建平行条目。若后续需要，应由唯一 owner 在下一轮按需补，不在本候选猜测。

**未改动 `.appsdk/project.json`**：D04 的路径（`server/**`、`network/**`、`runtime/**`、
`cli/**`）已由 `teams-source` 的 `owned_paths` 与 `regression.input_paths` 覆盖（`cli/**` 由
D01 绑定 `48ce0c9` 准入），`minimum_test_count` 保持 304；本候选不引入无依据的数字。

**未改动 `AGENTS.md`**：D04 未改变项目事实边界，新目录仍由既有模块与五张 map 承载，因此
无需重跑 `appsdk guide compile`。

## 4. 合并与冲突解决

```
git worktree add -b codex/acp-d04-bind-20261010 <path> 48ce0c9
git cherry-pick -x 953d952
# CONFLICT (content): Merge conflict in tsconfig.runtime.json   ← 唯一冲突，与 review 预测一致
```

解决方式：取 `48ce0c9` 的 `include` 数组（36 项，含 D01 的 `acp-adapter/stdio.ts`、
`agent-host/acp-host.ts`、`runtime/acp-history-store.ts`、`runtime/acp-daemon.ts`），把 D04 的
四项 `network/registration-client.ts`、`server/registry-intent.ts`、
`runtime/registry-process.ts`、`runtime/registry-registration.ts` 追加到同一数组末尾，得到
40 项、无重复、无删除。

D04 语义未变的核对：

```
git diff --stat 953d952 -- server/relay.ts server/registry-intent.ts server/registry-intent.spec.ts \
  network/registration-client.ts network/registration-client.spec.ts runtime/registry-process.ts \
  runtime/registry-process.spec.ts runtime/registry-registration.ts runtime/registry-registration.spec.ts \
  server/relay.spec.ts cli/agentteams.mjs cli/agentteams.spec.ts
→ 空输出（13 个 D04 文件与已审候选逐字节一致）

git diff 953d952 -- tsconfig.runtime.json
→ 只有 include 一行：D04 的“单独一行追加”被合并进 D01 已重写的同一数组；无条目增删
```

`pnpm build:runtime` 同时产出 D01 与 D04 的编译产物，证明合并后的 include 数组语义完整。

## 5. F1 解决与真实启动结果

F1 的收口方向是让契约说真话，不放宽实现，也不改 `config/daemon-intent.ts` 的解析行为。

**已提交示例是真实可启动输入。** 按示例注释里的命令，在 `config/examples/` 生成临时证书后：

```
mkdir -p config/examples/certs
(cd config/examples && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=registry-host" -keyout certs/registry-key.pem -out certs/registry-cert.pem)
export EXAMPLE_REASONER_REGISTRATION=example-reasoner-secret
export EXAMPLE_CONTROL_REGISTRATION=example-control-secret
node cli/agentteams.mjs registry start  --config config/examples/registry.toml
node cli/agentteams.mjs registry status --config config/examples/registry.toml
node cli/agentteams.mjs registry stop   --config config/examples/registry.toml --generation 1
```

实测结果（日志在 run notes：`f1-start.log`、`f1-status.log`、`f1-listener.log`、
`f1-child.log`、`f1-stop.log`）：

```
started  state=running generation=1 config=<worktree>/config/examples/registry.toml daemon=lan-registry pid=59253 url=wss://127.0.0.1:7444   (exit 0)
status   state=running generation=1 ... pid=59253 url=wss://127.0.0.1:7444                                                                   (exit 0)
lsof     node 59253 ... TCP 127.0.0.1:7444 (LISTEN)
ps       node .../generated/runtime-lib/runtime/registry-process.js --config <worktree>/config/examples/registry.toml --launcher-start-token 945b570d-...
stopped  state=stopped generation=1 ... pid=59253                                                                                           (exit 0)
after stop: ps -p 59253 → 无输出（rc=1）；lsof -iTCP:7444 -sTCP:LISTEN → 无输出（rc=1）
```

**环境前提已如实说明**：示例引用的证书/密钥由操作者生成，不随仓库提交（提交私钥是错的），
两个 `env:` admission 值也必须在启动前设置。因此“开箱即启”不成立；这是显式前提，不是静默成功。
真实失败文本（`f1-missing-cert.log`、`f1-missing-env.log`、`f1-no-tls-start.log`）：

```
缺少证书/密钥：exit 1  registry process failed to start: ENOENT: no such file or directory, open '<...>/config/examples/certs/registry-key.pem'
缺少环境值：    exit 1  registry process failed to start: credential environment EXAMPLE_REASONER_REGISTRATION is missing or empty
缺少 TLS 引用： exit 1  registry listen requires explicit tlsCertRef and tlsKeyRef, even on a loopback address; generate a local certificate with: openssl req -x509 ... -keyout certs/registry-key.pem -out certs/registry-cert.pem
```

**两层规则各自为真**（对示例去掉 TLS 两行的副本执行）：

```
parseDaemonIntent / compileDaemonIntent / readDaemonEffectiveConfig → OK（schema 层接受 loopback 省略 TLS）
node cli/agentteams.mjs registry start --config <no-tls copy>       → exit 1，TLS_REQUIRED（registry 运行时层拒绝）
```

因此 §3 现在同时陈述：schema 允许 loopback 省略（`config/daemon-intent.ts` 实际行为），
registry 实现复用 TLS-only 的 `server/Relay` 而显式失败（owner `server/registry-intent.ts`），
不声称 schema 禁止，也不声称运行时接受。`config/daemon-intent.ts` 未改动。

测试后已删除临时 `config/examples/certs/` 与 `config/examples/state/`；`git status` 无残留。

## 6. 证据（分面，命令均在候选 worktree 根目录执行）

| 证据面 | 命令 | 结果 |
| --- | --- | --- |
| 依赖安装 | `pnpm install --frozen-lockfile` | exit 0（pnpm 10.31.0，node v22.22.2） |
| D04 定向 suite（review 的 61） | `pnpm exec vitest run --no-file-parallelism server/relay.spec.ts network/relay-client.spec.ts network/registration-client.spec.ts server/registry-intent.spec.ts` | **61/61 PASS**，4 files（relay 29、relay-client 21、registration-client 6、registry-intent 5） |
| D04 gate（review 的 73） | 同上再加 `runtime/registry-process.spec.ts runtime/registry-registration.spec.ts` | **73/73 PASS**，6 files（+6/+6） |
| CLI suite | `pnpm exec vitest run --no-file-parallelism cli/agentteams.spec.ts` | **26/26 PASS** |
| D00 gate（F1 回归） | `pnpm exec vitest run --config vitest.config.ts config/daemon-intent.spec.ts config/acp-policy.spec.ts` | **35/35 PASS**（含示例解析/编译与 loopback/非 loopback 负例） |
| 类型检查 | `pnpm typecheck` | exit 0（root + opencode-adapter + console-host + ui/teams-console） |
| runtime 构建 | `pnpm build:runtime` | exit 0；`generated/runtime-lib` 含 `server/registry-intent.js`、`network/registration-client.js`、`runtime/registry-{process,registration}.js` 与 D01 的 `acp-adapter/stdio.js`、`agent-host/acp-host.js` |
| 五张 map 解析与交叉引用 | `python3 .worker-runs/acp-d04-bind-20261010/validate-maps.py` | 五张 map parse OK、duplicate_keys=none、无悬空 `required_gates`；见第 7 节 |
| F1 真实启动 | 第 5 节的 start/status/stop 序列 | start/status/stop 均 exit 0，PID 与 listener 经显式核对后消失 |
| 黑盒（候选证据，非本轮执行） | 候选 `953d952` 的 `blackbox-registry.mjs` | **14/14 PASS**（07:58:52Z–08:00:30Z），由 review 独立复现；本集成候选未重跑 |
| Review | 独立 review 报告 | **PASS** + 必须跟进 F1 |
| Merge/集成 | 本 receipt 所在提交 | cherry-pick `31db4ce` + 治理提交 |
| AppSDK compile/verify | `appsdk compile` / `appsdk verify` | **BLOCKED（环境）**：exit 1，`PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0014:required_binary=appsdk-0.1.0014`（本机 appsdk 0.1.8） |

这些是**源码/测试/类型/构建/单机启动**证据。除第 5 节的单机示例启动外，没有安装副本、
restart、live daemon、真实引擎推理或浏览器证据；本候选未执行任何安装或重启。

## 7. map 校验命令与结果

脚本：`.worker-runs/acp-d04-bind-20261010/validate-maps.py`（含重复键 hook 与交叉引用解析）。
实测输出（`validate-maps.log`）：

```
function-map: parse OK, duplicate_keys=none
mainline-call-map: parse OK, duplicate_keys=none
module-registry: parse OK, duplicate_keys=none
resource-map: parse OK, duplicate_keys=none
verification-map: parse OK, duplicate_keys=none
function-map dangling required_gates: none
mainline planned_bindings dangling required_gates: none
mainline edges dangling chain_id (advisory, pre-existing): ['endpoint-discovery-admission-v1', 'session-control-v1']
same set at HEAD: ['endpoint-discovery-admission-v1', 'session-control-v1']
D04 introduced no new dangling chain_id: True
mainline planned_bindings dangling chain_id: none
RESULT: PASS
```

- 新增 gate `teams-acp-d04-registry` 在 `verification-map.json` 只出现一次，全部
  `required_gates` 引用可解析。
- 新增链 `acp-registry-v1` 的 5 条边与 3 条 planned binding 全部可解析。
- **既有悬空（非本次引入）**：`edges` 中 2 个 chain_id 只在边里出现、未在 `chains` 声明——
  `endpoint-discovery-admission-v1`（1 条）与 `session-control-v1`（3 条）。用
  `git show HEAD:docs/architecture/mainline-call-map.json` 复算，`48ce0c9` 上同样存在；
  本次未新增也未修复，修复涉及 endpoint/session-control owner，超出 D04 绑定范围。

## 8. 明确 NOT proven（不得从前一层推断）

1. **无引擎级断电集成**。`network/registration-client.ts` 在 registry 断电下不崩、按有界退避
   重连，但 `runtime/agent-daemon.ts` 未改动，没有任何 engine/daemon 消费该 client，因此
   “真实引擎在 registry 断电下存活”没有证据。
2. **无安装副本/live 证据**。没有 npm pack/install、没有 installed CLI 入口 replay、
   没有 daemon start/restart、没有 `--serve` 真实启动；`teams-acp-serve-entry` 仍 `design`，
   `--serve` 调用方与 D02/D03 引擎 adapter 不存在。
3. **AppSDK gate 被环境阻断**（第 6 节），本候选不把该 gate 记为通过。
4. **全量 `pnpm test` 未在本候选重跑**：候选 `953d952` 记录 186 suites、854 passed、
   **2 failed**、0 pending、0 todo。两条失败是既有 load-sensitive 失败，不是 D04 代码：
   `runtime/agent-process.spec.ts`（Console deadline 9884 ms）与
   `runtime/managed-opencode-session.spec.ts`（abort 12714 ms）；两条在
   `--no-file-parallelism` 下单独跑通过（5763 ms / 2951 ms）。D00 基线 `f4783fb` 记录
   3 failed，是候选失败集合的超集。本候选不宣称全量回归通过，也不把该结果升级为 D04 证据。
5. **registry 租约不终止 socket、不关闭既有 grant**（设计如此，presence 是租约，
   `grantTtlMs` 单独约束 grant）；**admission generation 按 server 实例重置**，重启后回到 1；
   **没有 `peerTtlMs` 的 CLI/config 覆盖**，以保持单一配置源。这些是 D04 的既有设计边界，
   不是本轮的缺陷。
6. **两处 D01/D00 期的过期措辞未改**（超出 D04 范围，留给对应 map/文档 owner）：
   `docs/design/teams-acp-daemon-config-v4.md` 头部仍写 D00 范围的“运行实现仍 pending”；
   `docs/architecture/verification-map.json` 的 `teams-acp-daemon-intent` note 仍写
   “the D01 stdio adapter … do not exist”，而 D01 已在源码层交付。D04 只改了自己造成的
   依赖状态（`teams-acp-serve-entry` 的 D01/D04 依赖措辞），不替 D01 改它的 note。

## 9. 未完成的绑定 / 缺口

1. `teams-acp-d04-registry` 保持 `partial`：引擎级断电集成、安装副本与 live `--serve` 证据
   缺失，AppSDK 被 pin mismatch 阻塞；可执行下一步是安装 pin 匹配的 `appsdk-0.1.0014` 并跑
   `appsdk compile && appsdk verify`，以及等 D02/D03 与 `--serve` 调用方。
2. `docs/architecture/resource-map.json` 未加 D04 资源条目（见第 3 节理由）。
3. `.appsdk/project.json` 未改；`minimum_test_count` 保持 304。
4. 第 7 节的 2 个既有悬空 `chain_id` 仍未修复。
5. 未 push、未合并 main；由主集成编排决定后续。

## 10. 资源

- 独占 worktree：`/Volumes/Intel/playground/agentteams/acp-d04-bind-20261010`，
  branch `codex/acp-d04-bind-20261010`，owner = 本 worker；保留到主集成完成 review/merge/
  远端 receipt 后回收。
- Run notes：`/Volumes/Intel/playground/agentteams/.worker-runs/acp-d04-bind-20261010/`
  （pnpm install、build、gate、typecheck、map 校验、F1 start/status/stop 与三种失败日志）。
- F1 测试用临时证书/密钥与 state 目录已删除（`config/examples/certs/`、
  `config/examples/state/`），`git status` 无残留；registry 子进程用显式 PID 停止，
  未使用 `pkill`/`killall`；未删除或改动他人 worktree 与共享 base。
