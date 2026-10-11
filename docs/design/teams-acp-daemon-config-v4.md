# Teams ACP daemon 单 daemon 配置 v4 与公共契约（D00）

状态：D00 候选契约，等待独立 review 与集成；运行实现仍 pending。
基线：`origin/main@1b53e2be544fbc73559cba30db8062169f4b3d79`。
语义 owner：config（配置意图、编译与策略词汇）、control-protocol（公共 frame/DTO/状态）。
计划输入：ACP/LAN/WebUI 总目标与 D00 任务由外部计划树提供
（`docs/goals/teams-acp-network-delivery.md`、`docs/goals/teams-acp-network-tasks/D00-contract-config.md`）。
该计划树尚未随本候选提交，因此这里不建立相对链接，避免死链。
长程责任合同见 [teams-long-running-delivery.md](../goals/teams-long-running-delivery.md)。

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
| D06 | `HistoryQuery`/`HistoryPage`/`HistoryReadPort`、`parseHistoryQuery` | 声明 history 读取 API 的实际 owner 与分页语义。 |
| D07 | 只消费 `console-api.ts` 的 Console DTO | 不从历史反推在线或执行状态。 |

## 9. 示例配置

`config/examples/` 提供可直接解析与编译的示例；它们被 `config/daemon-intent.spec.ts` 作为真实输入读取，因此示例不会与 schema 漂移。

| 文件 | kind | 用途 |
| --- | --- | --- |
| `agent-opencode.toml` | agent | OpenCode agent，含 provider、两个 manual model 与 primary/backup binding。 |
| `agent-dsh.toml` | agent | DSH agent，含 `openai-responses` provider 与 reasoning model。 |
| `control.toml` | control | 控制 daemon，loopback WebUI + auth、discovery、peer。 |
| `registry.toml` | registry | 注册 daemon，loopback listen 与两条 admission。 |

示例只使用占位凭据引用（`env:EXAMPLE_*`）与 `file:./certs/*` 路径，不含真实密钥；解析与编译不会读取这些文件。

## 10. 非目标

D00 不实现：stdio ACP adapter（D01）、CLI 与 runtime 接线、引擎启动、网络 transport、注册服务实现、UI，以及根 `AGENTS.md` 与五张 `docs/architecture/` map 的绑定（主集成单 writer）。
