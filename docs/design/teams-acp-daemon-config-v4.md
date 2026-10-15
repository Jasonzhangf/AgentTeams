# Teams ACP daemon 单 daemon 配置 v4 与公共契约（D00）

状态：D00 契约已定稿并集成（候选 `9a511de`，review findings 已关闭）；本集成候选
补上根 `AGENTS.md`、开发管控、长程入口与五张 map 的 planned 绑定。运行实现仍 pending。
> 2026-10-14 更正：上面这句「运行实现仍 pending」写于 D00 候选 `9a511de`，只描述当时的状态。
> 到本候选为止 D01–D06 都已在源码层交付并有各自的真实入口黑盒证据：D01 stdio ACP 适配器、
> D02/D03 OpenCode 与 DSH 的 `--serve` 入口、D04 registry daemon 与自动注册、D05 Teams 传输与
> 协商、D06 control daemon 与 WebUI（另有 D08 的 installed-artifact/restart 与 A11 的两机
> cross-device 回执，各按自己的边界）。仍然未交付的部分按 gate 记录在
> `docs/development-governance.md`：没有 deployed-entrypoint 回放，Session owner 与定向 ACP
> ingress 仍未绑定。
基线：`origin/main@1b53e2be544fbc73559cba30db8062169f4b3d79`。
语义 owner：config（配置意图、编译与策略词汇）、control-protocol（公共 frame/DTO/状态）。
计划输入：ACP/LAN/WebUI 总目标与 D00 任务由计划 owner 持有的外部受控计划树提供
（`docs/goals/teams-acp-network-delivery.md`、`docs/goals/teams-acp-network-tasks/D00-contract-config.md`）。
该计划树尚未入库；根 `AGENTS.md`、`docs/development-governance.md` 与
[长程交付合同](../goals/teams-long-running-delivery.md) 按标题和任务编号引用它，
不建立相对链接，避免死链。

本文件是 D00 的 schema/ABI 决策与迁移说明，并记录各下游可引用的输入版本。

## 1. 冻结决策

| 决策 | 内容 |
| --- | --- |
| schema version | `4`。一份配置文件恰好声明一个 daemon；多目标用多份文件分别启动。 |
| canonical kind | `agent`、`control`、`registry`。`registry` 是公共 kind；实现复用现有 `server/Relay` 目录，不新建第二个目录 store，也不改目录名。 |
| v3 处理 | v3 多-agent 配置（`[bridge]`/`[agents.*]`）在新的 `--serve` 入口明确拒绝：`UNSUPPORTED_VERSION`，并给出迁移到 v4 的提示。旧 `init/start/status/work/console` 入口保持原 v3 行为，本交付不改动它们。 |
| provider/catalog/model | 继续由 `config/runtime-config.ts` 唯一拥有。`config/daemon-intent.ts` 只把文件字段映射到既有类型，并复用 `validateProvider`、`validateModelEntry`、`validateBinding`、`assertBindingTargets`。 |
| 本交付范围 | 只声明 engine adapter port、ACP frame/fault、Teams 协商与连接状态、history 读取 port。不实现 stdio adapter（D01），不接线 CLI/runtime，不实现引擎、网络 transport、注册实现或 UI。 |
| 门禁接线 | 新增类型已落在 `config/**` 与 `control-protocol/**`，被根 `tsconfig.json` 与 `vitest.config.ts` 现有 include 覆盖。新增契约文件同时加入 `tsconfig.runtime.json` 的 include，使 runtime build 产出并声明这些公共契约，供 D01–D07 从 `generated/runtime-lib` 引用。 |

## 2. 配置编译入口（owner: config）

文件：`config/daemon-intent.ts`。

| 导出 | 语义 |
| --- | --- |
| `parseDaemonConfigText(text, context?)` | TOML 文本 → `DaemonIntentV4`。TOML 语法错误显式失败。 |
| `parseDaemonIntent(value, context?)` | 已解码文档 → `DaemonIntentV4`。closed schema；未知字段、错误 kind、多个 daemon 均拒绝。 |
| `createDaemonIntentContext()` | 同一进程读取多份配置时的共享所有权上下文；拒绝重复身份、重复 host/account/scope 与重复 dataDirectory。 |
| `applyDaemonCliOverrides(intent, overrides)` | 显式 CLI 值覆盖配置；返回生效 intent，不修改输入，并对生效监听重新执行策略检查。 |
| `resolveDaemonIntent(intent, { configDirectory })` | 解析 dataDirectory、workspace 与 `file:` 引用为绝对路径；不读取秘密、不改写源文件。 |
| `compileDaemonIntent(intent, { configDirectory })` | 先用 `resolveDaemonIntent` 得到解析后的 intent，再由该结果编译 `VersionedRuntimeConfig` accepted 快照；不写 `effectiveRevision`，也不存在被丢弃的解析调用。 |
| `readDaemonEffectiveConfig(intent)` | 生效值的只读回读（kind、daemonId、dataDirectory、engine、listener）；永不回显秘密。 |
| `DAEMON_INTENT_VERSION` | `4`，供下游声明输入版本。 |
| `REGISTRY_IMPLEMENTATION` | `'server/Relay'`，声明 registry 的实现复用，不产生第二套目录。 |

配置意图类型：`AgentDaemonIntent`、`ControlDaemonIntent`、`RegistryDaemonIntent`。
ACP 策略意图：`AcpPolicyIntent`（`config/acp-policy.ts`）。
`RelationRole` 只在 control-protocol 的 `teams-connection.ts` 声明一次，`daemon-intent.ts` 只 re-export。

## 3. 三类 daemon 的必需与禁止字段

| 字段 | agent | control | registry |
| --- | --- | --- | --- |
| `daemon`（kind/id/hostId/accountId/scopeId/dataDirectory） | 必需 | 必需 | 必需 |
| `engine` | 可选；`acp.enabled = true` 时必需 | 禁止 | 禁止 |
| `listen` | 可选；`acp.enabled = true` 时必需 | 禁止 | 必需 |
| `webui` | 禁止 | 必需 | 禁止 |
| `acp` | 可选（默认 disabled） | 禁止 | 禁止 |
| `relations` | 可选（默认 `["peer"]`） | 可选（默认 `["peer"]`） | 禁止 |
| `admissions` | 可选 | 可选 | 可选 |
| `discovery` | 可选 | 可选 | 禁止 |
| `peers` | 可选 | 可选 | 禁止 |
| `providers`/`models`/`model` | 可选（provider/catalog/model 由 config 拥有） | 禁止 | 禁止 |

`listen.ip` 必须是具体数字 IP；`0.0.0.0`/`::` 通配地址被拒绝，避免隐式广播。
非 loopback 的 `listen` 需要 `tlsCertRef` + `tlsKeyRef` 且至少一条 `admissions`。
非 loopback 的 `webui` 需要 `webui.auth` 与 TLS 引用。
`credentialRef` 只接受 `env:NAME` 或 `file:<path>`；不接受明文。
`dataDirectory` 必须是 daemon 自有的目录路径，不接受 `.`/`..`。

**loopback registry 的 TLS 规则分两层，按实际行为分别陈述：**

- schema 层（`config/daemon-intent.ts` 的 `parseDaemonIntent`）：loopback 的 `listen`
  允许省略 `tlsCertRef`/`tlsKeyRef`；只有非 loopback 才强制 TLS 引用与至少一条
  `admissions`。因此一份 loopback registry 配置省略 TLS 引用仍能通过解析与编译。
- registry 运行时层（owner：`server/registry-intent.ts` 的 `resolveRegistryServerPlan`）：
  registry 复用仅支持 TLS 的 `server/Relay`，所以任何 `listen`（包括 loopback）都要求
  显式 `tlsCertRef` + `tlsKeyRef`；缺失时以 `TLS_REQUIRED` 明确失败，并给出生成证书的
  命令。运行时不会静默生成证书，也不会降级为明文 `ws`。

因此 loopback 省略 TLS 引用是“schema 接受、registry 启动失败”，不是“可以启动”。
`config/examples/registry.toml` 因而显式声明 `file:./certs/registry-cert.pem` 与
`file:./certs/registry-key.pem`，并在注释中记录首次启动前要执行的命令：

```
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=<registry-host>" -keyout certs/registry-key.pem -out certs/registry-cert.pem
```

openssl 命令与 `server/registry-intent.ts` 的 `REGISTRY_TLS_OPENSSL_COMMAND` 相同；
`certs/` 目录必须先存在（上面的 `mkdir -p`），openssl 不会自动创建它。

身份与存储约束（不传 `context` 时逐文件检查，传入共享 `context` 时跨文件检查）：

- 同一 `kind` + `hostId` + `accountId` + `scopeId` + `id` 只能声明一次。
- 同一 `hostId` + `accountId` + `scopeId` 不能被两个 daemon 同时占用（同一台机器身份只能有一个 daemon）。
- 同一 `dataDirectory` 不能被两个 daemon 复用。
- 一个 daemon 不能在 `peers` 或 `admissions` 中引用自身 `id`；`peers`/`admissions` 内不得出现重复 `agentId`。

## 4. 错误语义

`DaemonIntentError.code` 复用既有 config 错误词汇，并新增两个本交付语义：

| code | 触发 |
| --- | --- |
| `UNSUPPORTED_VERSION` | 文件 `version` 不是 4；v3 多-agent 文件附迁移提示。 |
| `UNSUPPORTED_CONFIGURATION` | 合法 schema 用在当前 kind 无法满足的方式，例如 `--serve <engine>` 指向 control/registry，或一份文件声明多个 daemon。 |
| `AUTHENTICATION_REQUIRED` | 非 loopback 的 webui 缺少 `webui.auth`。 |
| `INVALID_INPUT` | 未知字段、类型错误、非法 IP/端口、非法引用形式、`dataDirectory` 为 `.`/`..`、自身或重复 peer/admission 身份、非 loopback 缺少 TLS/admissions。 |
| `CONFLICT` | `model.backup` 与 `model.primary` 相同（复用 `validateBinding`）；重复 daemon 身份/所有权/dataDirectory（共享 context）。 |
| `NOT_FOUND` | `models`/`model` 引用未声明的 provider 或 model（复用 `assertBindingTargets`）。 |

provider 与 model 的字段语义错误（协议、URL、凭据引用、metadata 类型）统一由 `config/runtime-config.ts` 的验证函数抛出，错误文本以 `config:` 前缀标识唯一 owner。

## 5. CLI 优先级与读回

规则：

1. 显式 CLI 值覆盖配置文件：`--serve <opencode|dsh>` 覆盖 `engine.kind`，`--ip`/`--port` 覆盖该 daemon 的监听地址与端口。
2. `--ip` 与 `--port` 必须同时给出；只给一个时报 `INVALID_INPUT`。
3. `--serve` 只对 agent 生效；对 control/registry 报 `UNSUPPORTED_CONFIGURATION`。
4. `--serve` 与配置的 engine kind 不同时只保留 `kind` 与 `workspace`，**丢弃配置中的 `executable`**：已安装的 OpenCode 二进制不是 DSH 二进制。kind 相同时保留配置的 `executable`。
5. 覆盖后的生效监听重新执行同一套策略检查；非 loopback 且缺少 TLS/admissions 时明确失败，不静默降级。
6. 覆盖结果就是生效 intent；`readDaemonEffectiveConfig` 读回同一值，因此读回不会显示被覆盖的旧配置值。
7. 无配置的快捷启动由 CLI 单 writer 构造基础 intent 后再调用同一覆盖函数；D00 不定义身份持久化或默认凭据。

## 6. 公共契约（owner: control-protocol）

| 文件 | 导出 | 版本 | 说明 |
| --- | --- | --- | --- |
| `control-protocol/acp.ts` | `AcpFrame`、`AcpRpcId`、`AcpChannelRef`、`AcpIngress`、`AcpDelivery`、`AcpFault`、`AcpError`、`HistoryRecord`、`parseAcpFrame`、`parseAcpFault` | ACP JSON-RPC 2.0 envelope | 完整 JSON-RPC 对象原样保留；合法扩展、`_meta`、params/result 不被裁剪或改写。 |
| `control-protocol/engine.ts` | `AcpDuplex`、`EngineLaunchInput`、`EngineLaunchSpec`、`EngineAdapter`、`EngineHandle`、`EngineStopResult` | port v1 | engine adapter 公共 port；具体 stdio 传输由 D01 实现。 |
| `control-protocol/teams-connection.ts` | `RelationRole`、`TeamsAgreement`、`TeamsConnectionPropose/Accept/Reject/Confirm/Ready/Context`、`TeamsAcpOpen/OpenAck/Frame/Close/Error`、`parseTeamsConnectionFrame` | frame `version = 1` | 双方 master/peer 协商与 ACP 通道 frame；`subordinate` 不存在，非法角色对拒绝。 |
| `control-protocol/teams-state.ts` | `TeamsConnectionState`、`TeamsConnectionStatus`、`HistoryQuery`、`HistoryPage`、`HistoryReadPort`、`parseTeamsConnectionState`、`parseTeamsConnectionStatus`、`parseHistoryQuery` | status/query `version = 1` | 连接生命周期与 history 读取 DTO。 |

复用而非复制：

- 请求/执行生命周期沿用 `control-protocol/agent-services.ts` 的 `RequestState`，本交付不新增第二套执行状态。
- 注册 presence 沿用 `server/directory.ts` 的 `HostHealthState`；D04 绑定注册与租约事实。
- Console DTO 沿用 `control-protocol/console-api.ts`；D06/D07 不新增同义类型。
- `control-protocol/engine.ts` 只以 `import type` 引用 config 的 `AcpPolicyIntent` 与 `VersionedRuntimeConfig`，因此运行时不产生 control-protocol → config 依赖边；policy 语义仍由 config 唯一拥有。
- fault 只有一个 owner：`AcpFault`/`AcpFaultCode`/`AcpError` 只在 `control-protocol/acp.ts` 声明。`config/acp-policy.ts` 不再声明 `AcpPolicyError`，而是 re-export 同一个 `AcpError`；`teams-state.ts` 的 `error` 字段复用 `parseAcpFault`，DTO 形状错误也抛同一个 fault carrier。
- `RelationRole` 只在 `control-protocol/teams-connection.ts` 声明；`config/daemon-intent.ts` 只 re-export，不产生第二份角色词汇。

## 7. 迁移 v3 → v4

v3 文件不会被静默接受，也不会被自动改写。迁移按语义拆分：

| v3 | v4 |
| --- | --- |
| `version = 3` + `[bridge]` | 每份 v4 文件去掉 `[bridge]`；本地组合启动由 CLI 显式选择（D04/D06 绑定）。 |
| `[agents.<id>]` 多目标 | 每个 agent 一份 v4 文件，`[daemon].kind = "agent"`，`id` 取原表键。 |
| `[agents.<id>.identity]` | `[daemon]` 的 `hostId`/`accountId`/`scopeId`/`dataDirectory`。 |
| `[agents.<id>.runtime].policy` | `[acp]` 的 `required`/`blacklist`；能力词汇见 `config/acp-policy.ts`。 |
| provider/model/binding 段 | 保持同一语义，映射为 `[providers.*]`、`[[models]]`、`[model.primary]`/`[model.backup]`。 |
| 原 relay/console 运行目标 | 单独一份 `kind = "registry"` / `kind = "control"` 文件。 |

迁移只改变用户意图文件的形状；`~/.agentteams/internal.toml` 的 accepted/effective 事实仍由原 owner 维护，本交付不迁移运行时状态。

## 8. 下游输入版本与回执要求

| 交付 | 可引用的 D00 输入 | 回执要求 |
| --- | --- | --- |
| D01 | `AcpFrame`/`AcpFault`/`AcpError`/`parseAcpFrame`（acp.ts）、`AcpDuplex`/`EngineAdapter`/`EngineHandle`（engine.ts） | 声明消费的导出名；stdio adapter 与 Session 语义由 D01 实现。 |
| D02/D03 | `EngineAdapter`、`EngineLaunchInput/Spec`、`AcpPolicyIntent`、`resolveAcpPolicy`/`assertAcpAllowed` | 声明真实引擎支持集合，不把 adapter 未实现的能力写进公共声明。 |
| D04 | `RegistryDaemonIntent`、`REGISTRY_IMPLEMENTATION`、`AdmissionIntent` | 声明注册/租约实现复用的 server/Relay 入口。 |
| D05 | `teams-connection.ts` 全部 frame（v1）、`TeamsConnectionState`/`TeamsConnectionStatus` | 声明协商完成条件与角色对；不得新增同义 frame。 |
| D06 | `HistoryQuery`/`HistoryPage`/`HistoryReadPort`、`parseHistoryQuery`、`TeamsStatusPort`（D05） | 已交付：`kind=connection` 由 D05 `createTeamsStatusPort` 唯一拥有并返回冻结 `HistoryPage`（含 `nextBeforeSequence` 分页）；`kind=request` 由同一 owner 拒绝，不新增第二历史源；控制运行时只在该单点消费该 port，未注入时保持类型化缺席，不从 history 推断在线或执行状态。 |
| D07 | `console-api.ts` 的 Console DTO；`HistoryQuery`/`HistoryPage`/`ConsoleProjectionSnapshot`/`ConsoleProjectionSubscriber`（`teams-state.ts`） | 交付面：`ui/teams-console` 只读消费认证后的 `GET /api/v1/projection`、`GET /api/v1/history` 与 `GET /api/v1/events` SSE，并在 UI 侧声明 additive `TeamsConsoleClientV1`；D07 不从历史反推在线或执行状态，也不得自建第二历史源或第二个连接端口。partial：D07 只证明真实 WebUI owner 投影/typed refusal 绑定，不声称 installed-copy replay、restart、deployed-entrypoint、cross-device receipt、live registry composition through serve entry、或 mobile 证据。 2026-10-14 更正（L11）：installed-copy replay 已在 WebUI DOM 层交付，证据为 `docs/evidence/acp-l11-installed-browser-20261014/`（final 包安装到源码树外、三个 daemon 均由 INSTALLED CLI 启动、真实 Chrome 渲染安装副本 origin，18 checks、退出码 0）；restart、deployed-entrypoint、cross-device receipt、live registry composition through serve entry 与 mobile 仍未交付。 |

## 9. 示例配置

`config/examples/` 提供可直接解析与编译的示例；它们被 `config/daemon-intent.spec.ts` 作为真实输入读取，因此示例不会与 schema 漂移。

| 文件 | kind | 用途 |
| --- | --- | --- |
| `agent-opencode.toml` | agent | OpenCode agent，含 provider、两个 manual model 与 primary/backup binding。 |
| `agent-dsh.toml` | agent | DSH agent，含 `openai-responses` provider 与 reasoning model。 |
| `control.toml` | control | 控制 daemon，loopback WebUI + auth、discovery、peer。 |
| `registry.toml` | registry | 注册 daemon，loopback listen + 显式 `tlsCertRef`/`tlsKeyRef` 与两条 admission。 |

示例只使用占位凭据引用（`env:EXAMPLE_*`）与 `file:./certs/*` 路径，不含真实密钥；解析与编译不会读取这些文件。`agentteams registry start` 会读取 `registry.toml` 的 TLS 引用和 admission 凭据，因此首次启动前必须按第 3 节生成证书并设置 `EXAMPLE_*` 环境值。缺少时启动以 exit 1 明确失败并回显子进程的原始错误：缺少证书/密钥为 `registry process failed to start: ENOENT ... registry-key.pem`，缺少环境值为 `registry process failed to start: credential environment ... is missing or empty`；`listen` 缺少 TLS 引用时由父进程在 spawn 前直接以 `TLS_REQUIRED` 失败。三种情况都不伪造成功。

## 10. 非目标与集成边界

D00 不实现：stdio ACP adapter（D01）、CLI 与 runtime 接线、引擎启动、网络 transport、注册服务实现和 UI。

主集成单 writer 已在同一增量补上根 `AGENTS.md`、`docs/development-governance.md`、长程交付合同和五张 `docs/architecture/` map 的 planned 绑定。绑定只声明 D00 的契约事实与待接线路径，`planned/design` gate 不标 implemented/passed。

`agentteams --serve opencode --ip --port` 已接线：`runtime/acp-serve.ts` 读取一份 v4 agent intent，经 `startAcpAgentDaemon`（D01 stdio ACP）与 OpenCode 引擎 adapter（D02）启动一个 daemon 加一个引擎子进程，真实 CLI 黑盒证据见 `docs/evidence/acp-d02-integration-20261010/`。`--serve dsh` 也已接线：同一入口的 `engineAdapterFor` 按配置的 engine kind 选择 `createDshEngineAdapter()`（D03），复用同一 daemon/host/stdio/readiness/stop 代码，遵守 `DSH_HOME` 隔离、派生 profile patch、`DSH_PERMISSION_MODE` 与 telemetry 关闭，并在 stop 与启动失败路径删除自有 engine home；每个 adapter 自己声明 `enforceablePolicies`（DSH 按 `dshHasPolicyEnforcementOwner` 规则派生），入口只要求该声明、缺失即以指名 adapter 的 typed fault 失败，绝不回退到 `declaredMethods`；真实安装的 DSH 0.2.0-rc.2 黑盒证据（真实派生配置、真实 prompt、cancel、显式 PID stop、零泄漏 engine home）见 `docs/evidence/acp-d03-serve-20261010/`。配置指向注册服务器时还依赖 D04。`teams-acp-serve-entry` 与 `teams-acp-d03-dsh` 均记为 partial，未标 passed/implemented；不新增只编译不启动的占位入口。

## 11. D00 amendment A1 — policy revision as v1 as amended (2026-10-11)

D05 closure delivered D00 amendment A1. The version remains `1`; the
amendment changes the Teams negotiation fields, not the frame version.

| Field | Frame | Source of truth | Parser rule |
| --- | --- | --- | --- |
| `policyRevision` | `teams.connection.context` | The responder's own accepted config revision, exposed through `TeamsConnectionContext.policyRevision`. | Required strict positive integer. Missing, non-integer, zero or negative values fail `INVALID_ACP_FRAME`. No default is supplied. |
| `sourcePolicyRevision` | `teams.connection.propose` | The initiator's own accepted config revision, carried as `TeamsConnectionPropose.sourcePolicyRevision`. | Required strict positive integer. Missing, non-integer, zero or negative values fail `INVALID_ACP_FRAME`. No default is supplied. |

The pre-A1 caller-supplied `peerPolicyRevision` input is removed. The
responder derives the peer revision from the propose frame and does not trust a
caller-supplied peer revision. A pre-A1 peer that omits either required integer
field is refused with `INVALID_ACP_FRAME`; it is not silently accepted or
assigned a default.

The negotiation agreement keeps integer accepted config revisions only. It never
uses a hashed `AcpPolicySnapshot.revision` or coerces a non-integer value.

## 12. D00 amendment A2 — control daemon wire increment and the status port (2026-10-11)

D06 (PART 1 and PART 2) delivered D00 amendment A2. The version remains `1`;
the amendment extends the control daemon wire surface additively and binds the
control runtime to the D05 network status port. The clauses below are carried
verbatim from `docs/evidence/acp-d06-control-20261011/notes.md` section 4.

> **D00 amendment A2（生效 2026-10-11，由 D06 控制守护进程提出）**
>
> A2.1 控制守护进程的线面只作**增量扩展**，不提升 frame version。既有的 v1 payload
> 继续有效，且未知键仍按闭合契约拒绝。控制守护进程不得为 Teams 连接声明第二个具名
> 端口，也不得复制 network 模块。
>
> A2.2 `GET /api/v1/history?version=1&kind=request|connection&agentId&sessionId&limit&beforeSequence`
> 返回冻结的 `HistoryPage`。这是唯一放宽"任何 query 参数即拒绝"的路由；其余路由的拒绝
> 语义逐字不变。
>
> A2.3 `GET /api/v1/events` 是真实 SSE 流（`content-type: text/event-stream`、
> `cache-control: no-store`）。每个事件携带完整 owner 投影快照 `{seq, projection}`，
> 客户端不维护 delta 存储。同一端点另发一条健康事件，复用冻结的
> `SessionObservationState` 词表（`live|degraded|lost`）。owner 丢失时服务端关闭流，
> 且不得伪造存活状态。
>
> A2.4 新增闭合命令种类，沿用既有 `expectedRevision` CAS 模式：
> `connection.connect{agentId}`、`connection.disconnect{agentId}`、
> `network.membership.apply{expectedRevision, members:[{agentId, role}]}`，其中 `role`
> 复用冻结的 `RelationRole`。未知种类仍失败。
>
> A2.5 增量可选投影字段只从既有 owner 真源投影：agent 行可带 `engine?` 与
> `lastSeenAt?`；投影可带一个复用冻结 `TeamsMembershipView`（或冻结
> `TeamsConnectionStatus` 列表 + `halfOpen` + 可选 `localRole`）的 connection 字段。
> 不得铸造同义词。
>
> A2.6 pending permission 事件可带引擎提供的
> `options: readonly {optionId, name, kind}[]`，回复可携带所选引擎 `optionId`。
> 不得伪造 option 集合，也不得为缺失或过期的回调自动批准。
>
> A2.7 控制运行时**结构性地**消费网络状态端口，仅使用冻结类型
> `{ history(query: HistoryQuery): Promise<HistoryPage>; connections(): readonly TeamsConnectionStatus[] }`。
> 该依赖未注入时必须以类型化错误显式失败；不得伪造连接状态，也不得从 history 推断
> 在线或执行状态。

### 12.1 D06 PART 2 的实际落点

- A2.7：唯一注入点是 `runtime/control-process.ts` 的 `createControlNetworkStatus(intent, env)`。
  它组合真实 owner 后调用 D05 的 `createTeamsStatusPort`（`network/teams-status.ts`），
  不声明本地 alias、不复制 network 模块。控制守护进程不声明 Teams listener，因此
  `connections()` 在无真实 channel 时是诚实的空列表；`kind=connection` 读真实持久历史，
  `kind=request` 由同一 owner 以非缺席失败拒绝（HTTP transport 报
  `Console owner request failed; outcome not inferred`），不引入第二个历史源。
  依赖未注入时 `createControlOwner`/`createControlHistoryReader` 仍以 `UNAVAILABLE` /
  `HISTORY_UNAVAILABLE` 类型化缺席失败。
- A2.6：owner 是 `agent-host/acp-host.ts`。`projectPermissionOptions` 把引擎真实
  `session/request_permission` 的 `options` 逐字投影为冻结 `ConsolePermissionOption`
  （`allow_once`/`allow_always` → `once`/`always`，`reject_once`/`reject_always` → `reject`），
  引擎未提供或提供空集合时返回无 option 集，畸形或重复 option 集以 `INVALID_ACP_FRAME`
  在投递前拒绝。`adjudicatePermissionReply` 只接受引擎真实提供的 `optionId`；未知
  outcome、空集合下的 selected 与未提供过的 `optionId` 都以类型化错误拒绝，因此缺失或
  过期回调永远不会变成批准。
- A2.1–A2.5 的线面契约由 PART 1 交付，本增量不改变它们的语义；本节只记录 A2 的题面。

`teams-acp-d06-control` 绑定本节的 spec 与真实黑盒证据，状态为 `partial`：没有
installed-copy 回放、restart、deployed-entrypoint、跨设备回执或浏览器证据（该句为本行写入时的状态）。2026-10-14 更正（L11）：其中 installed-copy 回放与浏览器证据已由 `docs/evidence/acp-l11-installed-browser-20261014/` 交付（从安装包执行 `control start`，用真实 Chrome 驱动该安装副本 origin，18 checks、退出码 0）；restart、deployed-entrypoint 与跨设备回执仍未交付。

## 13. D00 amendment A3 — engine instance on the connection context (2026-10-13)

The initiator side of ACP was not constructible. `AcpChannelRef.engineInstanceId` is a
required non-empty string, and `createTeamsSession` refuses an `acp.open` whose
`engineInstanceId` differs from the receiving daemon's own value with
`STALE_GENERATION`. No discovery surface carried that value, so a remote initiator
could not build a legal `acp.open` at all.

A3 resolves this by publishing the value on the surface that already carries its
sibling freshness facts. The version stays `1`; the amendment changes one Teams
negotiation frame, not the frame version.

| Field | Frame | Source of truth | Parser rule |
| --- | --- | --- | --- |
| `engineInstanceId` | `teams.connection.context` | The responder's own live engine instance, exposed through `TeamsConnectionContext.engineInstanceId`. | Required non-empty string. Missing, empty or non-string values fail `INVALID_ACP_FRAME`. No default is supplied. |

A3.1 The field belongs to the context frame, not to `AgentDeclaration`. The engine
instance is generated per engine process as `<engine kind>-<daemon id>-<uuid>`
(`runtime/acp-serve.ts`), so it is a connection-time fact. The declaration carries
identity and configuration facts (`identity`, `scopeId`, `revision`, `capabilities`,
`routes`) and is replicated through the registry. Publishing a per-process random
value there would churn the directory on every engine restart and would give one
freshness fact two sources.

A3.2 The context frame already carries the responder's own `targetGeneration`,
`capabilitiesRevision` and `policyRevision`. `engineInstanceId` is the same kind of
fact and is validated at the same boundary: `createTeamsSession` refuses a
mismatched `targetGeneration` and a mismatched `engineInstanceId` in two adjacent
checks at `openChannel`, and re-applies both together on every `acp.frame` in
`receiveFrame`. It rebuilds both from local values before any host call.

A3.3 The responder must supply a real value. `startTeamsNegotiation` refuses a
responder start whose `engineInstanceId` is absent or empty with
`INVALID_ACP_FRAME`, so a daemon cannot publish a placeholder.

A3.4 The initiator records the value as `TeamsNegotiationState.targetEngineInstanceId`
when it accepts the context, exactly as it already records `targetGeneration`. The
initiator names that recorded value on `acp.open`.

A3.5 The receiving side keeps its existing refusal. A peer that names a different
engine instance is still refused with `STALE_GENERATION` before any host call, and
the check is still re-applied on every `acp.frame`. A3 adds the publishing surface;
it does not weaken the guard.

A3.6 A3 is additive on the wire and breaks compatibility in both directions. A peer
that omits the key is refused `INVALID_ACP_FRAME` by the new check. A peer that
predates A3 and receives the context is also refused, because its closed key set
rejects the unknown `engineInstanceId` key. No default is supplied in either
direction. No v1 LAN peer was deployed, so no version bump is required.

A3.7 A3 alone did not deliver the initiator. The initiator channel-open primitive is
now delivered inside `createTeamsSession.open()`: it is the only place that sends
`acp.open`, it names the recorded `targetEngineInstanceId`, it adopts the ack ref as
its peer ref, and it keeps its own generation and engine instance on the host-facing
ref because `AcpHost.open` refuses a foreign pair. L9 adds the production
composition: `network/teams-egress.ts` is the outbound counterpart of
`network/teams-ingress.ts`, it runs the initiator negotiation over the frozen
frames, calls `createTeamsSession.open()` for the one ACP channel and observes
channel lifecycle with local refs only, so the handshake and the release rules keep
one owner. When A3.7 was written the egress did not run inside a daemon:
`runtime/acp-serve.ts` called only `openTeamsIngress`, so no deployed process dialed
an initiator channel. 2026-10-14 更正（L9 command side）：`runtime/acp-serve.ts` 现在组合
`runtime/serve-egress.ts` 并对已接受的 `peers` 拨出 initiator 通道，因此 egress 已在一个
daemon 内运行；真实入口证据见 `docs/evidence/acp-l9-command-side-20261013/`。

`teams-acp-d05-network` binds this amendment. It stays `partial`.
