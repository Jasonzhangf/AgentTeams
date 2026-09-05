# Teams Control Protocol v2 长程实现计划

状态：实施中
项目：Teams
治理：AppSDK `0.1.6`
负责人：Teams 唯一 developer

## 1. 目标

实现 Teams 跨机器多 Agent 控制协议 v2：Master Console Host 通过账号目录发现并连接多个 Agent Host，每个 Agent Host 包装一个独立 Agent runtime；每台 Agent Host 只维护一个健康 target transport，多个 Session 通过 logical channel 多路复用；通知、权限、会话和关系通过 typed channel 投影到 Master 控制台。

## 2. 验收标准

- `appsdk verify Teams` 与 `appsdk compile Teams` 持续通过。
- 控制面字段不进入 Session body/metadata；transport/channel 生命周期有正反向红绿测试。
- Agent Host 能注册 identity、capability、presence、route candidate，并在同账号 Master 目录中可见。
- Master 能消费 account directory generation，生成显式 route plan，不自动 fallback。
- 每个 Agent Host 保持一个 target WebSocket；多个 Session channel 可复用同一 transport。
- stale generation、unknown channel、非法状态转移显式失败，不静默恢复。
- OpenCode adapter 能通过 PluginInput/SDK/Hooks 暴露真实 Session/permission/notification；Console Host 能 live 回放。
- 每轮结束必须有定向测试、build 或 live 证据、AppSDK 治理验证，以及 `Teams/note.md`/`.agent-collab` 更新。

## 3. 范围与边界

In scope:

- Teams 自研控制协议、Agent Host、Master Host、Server directory、target transport、session channel mux。
- OpenCode-first Agent runtime 接入。
- Search/Memory 插件 lifecycle。
- Desktop/Mobile 共享 UI 语义，仅按排版区分。

Out of scope:

- DSH runtime 接入仍为 deferred。
- 不复制 zterm 源代码，只复用架构原则。
- 不实现 machine pairing；只有 `none` / `shared-api-key` / `shared-token` 无状态校验。
- UI 不直接拥有 Session、permission、config、network 或 server truth。

## 4. 当前基线

- 设计：`docs/design/teams-control-protocol-v2-master-agent-host.md`
- Manifest：`docs/design/teams-control-protocol-v2.manifest.json`
- Phase A 已实现：`control-protocol/frames.ts`、`control-protocol/channel-state.ts` 及 specs；定向测试 `16/16` 通过。
- 已知治理缺口：当前 `appsdk` binary 与 `sdk.lock`/migration record 不一致，`appsdk verify Teams` 被 `SDK_BINARY_DIGEST_MISMATCH`/`INVALID_SDK_MIGRATION_RECORD` 拦截。

## 5. Phase 路线

### Phase 0: AppSDK 治理修复（已完成）

- 将无效的 `0.1.5-to-0.1.6` migration record 备份到 `/tmp/teams-appsdk-migration-backup-20260904-003214` 后，使用官方 `appsdk pin-lock Teams --binary /Users/fanzhang/.local/bin/appsdk` 重写 SDK lock 与 migration record。
- `control-protocol/**` 已纳入 `.appsdk/maps/module-registry.json` owned paths。
- 完成标准：`appsdk verify Teams` 通过；`appsdk compile Teams` 通过；再次 `appsdk verify Teams` 通过。

### Phase A: Control Protocol Schema + Channel State Machine（已完成）

- 已实现 typed target control frame、session channel frame、channel lifecycle state machine。
- 保留已落盘的 `control-protocol/**`、specs 和 maps。

### Phase B: Agent Host Registration + Server Directory Skeleton（已完成）

- 已实现 Agent Host registration client：`network/host-registration.ts` 负责向 Server 上报 host identity、capability revision、presence、route candidates。
- 已实现 Server directory skeleton：`server/directory.ts` 保存 host 目录、generation、presence refresh、stale removal；不保存 Session/permission body。
- 验证：`server/directory.spec.ts` 与 `network/host-registration.spec.ts` 正反向测试通过；Phase A/B 定向测试合计 `28/28` 通过。

### Phase C: Master Account Directory + Route Plan（已完成）

- 已实现 Master account directory snapshot：`network/account-directory.ts` 负责同账号发现、目录 generation 确认、refresh 和 host 解析。
- 已实现 `manual` 与 `auto` route plan：`network/route-plan.ts` 生成显式候选顺序，失败 candidate 退休后才能进入下一候选；无 fallback、不能把成功改写成失败。
- 验证：Phase A/B/C 定向测试合计 `36/36` 通过。

### Phase D: Target Transport + Session Channel Multiplex（已完成）

- 已实现 target transport owner：`network/target-transport.ts` 覆盖 hello/handshake、health、generation、close/fail 显式状态。
- 已实现 Session logical channel registry：`network/session-channel-registry.ts` 支持一个 transport 打开多个 channel，open/ack/message/close/error 显式拒绝 unknown/stale 事件。
- 验证：Phase A/B/C/D 定向测试合计 `43/43` 通过；真实 WebSocket smoke 仍待后续 live 阶段。

### Phase E: Agent Host CLI + OpenCode Adapter Binding（基础绑定已完成）

- 已实现 `agent-host/agent-host.ts`：校验 Agent Host identity、endpoint、auth mode 和 credential reference，并把 OpenCode facade 绑定到 registration/projection/action surface。
- 已完成 OpenCode adapter 的 `PluginInput/SDK/Hooks` 基础绑定：session projection、permission reply、notification sink 和 ack action 均有 typed owner。
- 验证：Phase A-E 当前根级回归 `45/45`，OpenCode adapter `typecheck` 通过，Agent Host/network/server strict typecheck 通过；真实 OpenCode permission allow/reject/always 及 Console Host Camo 回放已有证据。
- 边界：Phase E 仍未提供独立 Agent Host 的真实网络 listener/WS ingress；该能力进入后续 runtime slice，不把静态 binding 误报为跨机器闭环。

### Phase F: Console Host + Master UI Live Integration

- Console Host 聚合多 Agent projection、notification center、approval action、session drawer。
- 用真实 OpenCode server 和 Camo 验证桌面 `1440x960`、手机 `390x844`，UI 只按排版区分。
- 验证：Agent badge、通知直达 Session、审批 allow/deny、current-session fast path 闭环。

### Phase G: 插件与交付收尾

- 接入 Search/Memory 插件 lifecycle；补齐 relation graph、settings、permission boundary。
- 运行 AppSDK lifecycle producer、review admission、AGY Review；通过后 commit/push。

## 6. 每轮执行规范

- 每个 Phase 一个 semantic claim/worktree；路径必须在 `playground/<issue-or-task>`。
- 先红测/绿测，再改唯一 owner 源码；不做 fallback、silent strip、双 owner。
- 修改代码前读 resource/function/mainline/module/verification map；实现后同步 map。
- 每轮结束写入 `.agent-collab/runs/<run_id>/notes.jsonl`，提炼到 `Teams/note.md`。
- 只有当前 Phase 的验证和治理通过后，才进入下一 Phase。

## 7. 完成定义

- Teams v2 控制协议有可安装、可 live 验证的 Master/Agent Host/Server/OpenCode adapter 链路。
- AppSDK records、review、merge/push 和远端 receipt 闭合。
- 跨机器多 Agent 可从 Console Host 发现、控制 Session、查看通知、执行审批，并支持 Search/Memory 插件接入。
