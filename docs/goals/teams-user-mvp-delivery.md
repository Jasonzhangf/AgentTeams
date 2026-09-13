# AgentTeams 用户可用本地 MVP 产品路径

状态：ready-for-goal-input

本文件是用户路径 brief，不是新的 goal、subscription 或 task graph。唯一的长程目标、派单
顺序、owner、review、integration、push、memory 和 cleanup 真源仍是
[teams-long-running-delivery.md](teams-long-running-delivery.md)；阶段依赖仍由
[teams-development-plan.md](teams-development-plan.md) 的 G0/L1-L5 定义。本 brief 只把
产品目标翻译成用户可以执行的路径，供下一次 `/goal` 引用。

## 用户看到的结果

用户只需要维护 `~/.agentteams/config.toml`，然后执行稳定的 AgentTeams 入口：

```text
agentteams init
编辑 config.toml
agentteams start
agentteams status
agentteams work
agentteams stop
```

完成后，至少一个 provider 和一个 receiver 必须通过本地真实网络 bridge 完成：注册、身份与
generation、directory、capability/resource 广播、匹配、连接、协商和一次 Agent Work
proposal/request/result/close。Console 可以观察和修改配置，但不是 Agent-to-Agent 数据路径；
Console 关闭后 Work 仍然能够完成。

公网 Relay、NAT/STUN、direct internet、手机入口、关系治理、完整 UI polish、自动 provider
failover 和生产部署继续属于 canonical 计划中的 post-MVP 阶段。

## 配置分层

### 用户真源：`~/.agentteams/config.toml`

只表达用户意图：

- machine 稳定标识；
- endpoint id 与 role：`provider`、`receiver`、`hybrid`；
- provider 暴露的 service/capability、operation 和资源容量；
- receiver 要连接的 target endpoint、service/capability、operation、demands 和业务 payload；
- 本地 bridge profile 或用户明确选择的 Relay endpoint；
- provider/model 绑定和 credential 的环境变量引用。

用户不需要填写 PID、generation、动态端口、resolved path、child JSON、启动时序或 runtime
状态。

### 内部真源：`~/.agentteams/internal.toml`

由 runtime 原子生成和维护，用户不直接编辑。它保存运行所需但不属于用户意图的内容：

- resolved endpoint/Relay 配置；
- child process 启动参数和派生配置位置；
- 实际监听端口、证书/密钥路径和 credential 引用；
- PID、generation、`online`/`stopped`/`failed`；
- config revision、启动时间、最近错误和恢复状态。

如果 child JSON 仍被进程入口需要，它只能从 `internal.toml` 临时投影，不能成为第二个可编辑
配置源，也不能反向覆盖 `config.toml`。这个边界已由 issue `159b78b` 交付并关闭；当前
权威证据见 `docs/evidence/159b78b-internal-config-20260913/`，后续 CLI/Work/Console 不得
重复派单或把该 receipt 当作完整 MVP 验收。

## 产品检查点与 canonical 阶段映射

这些是一个用户 MVP 的检查点，不创建新的调度阶段：

| 产品检查点 | canonical 阶段 | 用户可观察结果 |
|---|---|---|
| 内部配置编译 | G0 → L1 | `config.toml` 被解析，`internal.toml` 原子生成，child projection 不可编辑 |
| 用户入口 | L1 | `init/start/status/work/stop` 不要求用户调用生成 JS 或手写 Relay JSON |
| passive provider/receiver | L2 | provider 广播 capability/resource，receiver 按显式 target 发起 Work |
| 本地真实回放 | L5 | 两个独立 daemon 经 socket bridge 完成 discovery、协商、Work、stop/restart |
| Console 观察面 | L4，随后由 L5 收口 | UI 展示 directory projection，Console 关闭不影响 Work |

当前主线 `3668b324` 已包含 internal.toml 真源迁移（U0/`159b78b`）及本机双 daemon 基础；
用户 CLI、完整 passive provider/receiver Work、OpenCode 多 provider、Console directory
projection 和最终 Console-offline/restart 真实收口仍未完成。L1 CLI 当前等待 runtime issue
`3742b9a` 提供 detached lifecycle/status/stop 与 configured Work invocation；这不是 CLI 的重复实现范围。

## 用户 MVP 验收路径

在干净临时 home 中，最终候选必须支持：

```text
agentteams init
写入最小 config.toml
agentteams start
agentteams status
agentteams work
agentteams stop
agentteams start
agentteams status
```

必须留证：

- 两个独立 daemon 和 bridge 真实启动；
- discovery、broadcast、connect、negotiate 和 Work 全部走 socket；
- `internal.toml` 的 online/stopped/generation 与实际进程一致；
- restart 后旧 generation 被拒绝，新 generation 可以重新 Work；
- 用户没有编辑 internal.toml、child JSON、PID 或证书路径；
- provider 负责能力、资源和 Work admission，receiver 只提交连接意图；
- Console 不在线时 Agent-to-Agent Work 仍成功。

任务拆分、并发边界、资源回收和关闭条件统一引用 canonical 长程交付合同，不在本 brief 重复。
