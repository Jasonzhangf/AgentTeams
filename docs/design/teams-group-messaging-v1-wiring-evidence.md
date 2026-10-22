# 群组消息:生产装配与遗留项证据

本文件记录第一批交付后遗留项的收口证据,不改需求。设计正文仍是
`teams-group-messaging-v1.md` revision 5。设计第 18 节的第二批(模型执行:Session 映射、
queue/steer、讨论与 comment 执行)不在本文件范围内。

证据分层与第一批相同:单元、hub、黑盒。黑盒 = 真实 CLI 子进程、真实 TLS relay、
真实注册连接、进程内组合、真实 Unix 套接字、本地 HTTP Vikunja 替身。

## 1. 群组面挂在注册连接上

- `control-protocol/agent-services.ts` 增加客户端帧 `relay.group`,
  `control-protocol/relay-codec.ts` 负责编解码;服务端帧 `relay.group.reply`、
  `relay.group.push` 沿用已有定义。`control-protocol/relay-codec.spec.ts` 覆盖往返。
- `network/relay-client.ts` 在既有控制连接上发送群请求并接收回执与推送;只属于群请求的
  `relay.error` 交给群处理器,不会终止目录或心跳连接。`network/relay-client.spec.ts` 覆盖。
- `network/registration-client.ts` 暴露 `sendGroup` 与 `onGroup`,重连后重新挂接。
  `network/registration-client.spec.ts` 覆盖断线通知与重连重挂。
- `runtime/group-messaging.ts` 是唯一组合点:`createRegistrationGroupChannel` 把通道建在
  注册连接上,`forwardRegistrationStatus` 把在线/重连/失败转给通道,
  `startGroupAgentMessaging` 在通道上起 CLI 本地套接字。`runtime/agent-messaging.ts`
  不再自开 socket,也不再关闭 TLS 校验;它只持有注入的通道、本地套接字与外部写执行。
- `runtime/acp-serve.ts` 在注册启用时组合上述三者,退出时先关本地套接字再停注册客户端,
  句柄新增 `groupSocketPath` 供观测。

证据:`server/group-loop.spec.ts` 用两个真实 daemon 组合、真实 TLS relay 与真实 CLI 跑通
建群、建 issue、派遣并执行 action、写回与关闭,全部经注册连接;`runtime/agent-messaging.spec.ts`
覆盖请求转发、`op.execute` 回执与通道拒绝的 typed error。

边界:尚未在 `acp-serve` 内用真实 relay 端到端跑一次;该路径当前由
`server/group-loop.spec.ts` 覆盖,`acp-serve` 调用的是同一组函数。

## 2. `[vikunja]` 段只对 agent daemon 生效(A5)

- `config/daemon-intent.ts` 的 agent 形状接受可选 `[vikunja]`,control 与 registry 拒绝;
  `runtime/acp-serve.ts` 用同一解析器把 `tokenRef` 解析为运行期凭据后交给
  `vikunja-sync`。段缺失时不组合外部写能力,群请求仍可用。
- 证据:`config/daemon-intent.spec.ts` 覆盖存在、缺失、控制面拒绝与内联密钥拒绝。

## 3. 按群拆分持久化

- `server/group-file-store.ts` 实现 `GroupHubStore`:每个 account/scope 一个目录,
  `groups.json` 存注册表,每个群单独 `sessions.json`(含开闭意图)、`actions.json`、
  `external-ops.json`、追加式 `messages.jsonl`、`log.json`(保留起点)与每 agent 一个水印文件。
  消息只追加不重写;水印消失时对应文件被删除;无法归群的外部操作写入 `orphan-ops.json`
  而不丢弃。
- `runtime/registry-process.ts` 改用该 store,替换单体 `group-hub.json`。
- 证据:`server/group-file-store.spec.ts` 覆盖目录布局、重启恢复、只追加、水印删除、
  孤儿操作与截断尾行;`server/group-loop.spec.ts` 与 `runtime/registry-process.spec.ts`
  在真实组合下通过。

## 4. 目标 agent 的定址不再跨作用域猜测

- `server/relay.ts` 的 `socketForAgent` 在同一个 agentId 命中多个作用域时拒绝投递,
  而不是任选一个。这样跨账号同 id 不会串线。
- 未收口:推送路径仍只携带 agentId,未携带 account/scope;要做到精确投递需要把作用域
  加进 `GroupHubPush`。当前行为是"拒绝歧义",不是"按键投递"。
- 证据:`server/relay.spec.ts`、`server/relay-group.spec.ts` 全过;没有单独的歧义用例,
  因为该分支需要两个作用域同时在线才能触发。

## 5. `issue.reference` 回读目标 issue

- `server/group-hub.ts` 的 `referenceIssue` 变成异步:先做一次只读回读,必须拿到
  `projectId` 与 `actualState` 才建会话;回读未确认报 `RESULT_UNKNOWN`,确认但缺项目报
  `UPSTREAM_ERROR`,Vikunja 已关闭则建关闭态会话。同一 commit 重复引用返回同一会话且
  不再回读。占位值 `referenced` 已删除。
- `runtime/vikunja-sync.ts` 的 issue 读取增加 `project_id` 解析。
- 证据:`server/group-hardening.spec.ts` 四条新用例覆盖绑定真实项目与状态、未确认不建会话、
  缺项目拒绝、重复引用不二次回读。

## 复核修复

独立复核 4216fb1 判 FAIL,三条阻断已修:

1. `issue.query` 的回执丢掉 `projectId`,导致真实路径每次 `issue.reference` 都报
   `UPSTREAM_ERROR`。现在 `runOp` 把 `projectId` 原样带回;新增两条证据——
   `runtime/agent-messaging.spec.ts` 用本地 Vikunja 替身走 `runOp` 断言回执含项目,
   `server/group-loop.spec.ts` 用真实 CLI 引用一个本群从未创建过的 issue,断言会话绑定
   回读到的 `p9` 与 `closed`。
2. 崩溃留下的半行尾只从内存丢弃,下次追加会拼进半行并把整条记录弄坏。现在加载时
   `repairJsonLinesTail` 先把文件截到最后一条完整行,再追加;丢弃次数写进 `log.json` 的
   `repairedTails`。`server/group-file-store.spec.ts` 覆盖"修复后追加不损坏""再加一条不丢"。
3. 保留起点在重启后被还原成完整历史,`restoreMessageLog` 会拒绝启动。现在加载按
   `retentionStartSequence` 过滤并重写文件,保存时保留窗口一变就整file重写。
   `server/group-file-store.spec.ts` 覆盖"裁剪后重启不复活""保留窗口内仍只追加",
   并把加载结果送进 `createGroupHub` 与 `restoreMessageLog` 证明能启动。

同时收紧的复核意见:

- `issue.reference` 引用本群已绑定的 issue 时返回原会话,不再因唯一性检查报错。
- `acp-serve` 启动失败路径现在关闭已开的 CLI 套接字;去掉没有消费者的 `onError`。
- `runtime/acp-serve.spec.ts` 新增组合用例:注册启用时 `groupSocketPath` 非空、位于数据目录,
  且注册不可达时 CLI 请求得到 typed 错误而不是本地伪成功。

## 5. TLS 校验默认开启

- `runtime/agent-messaging.ts` 不再自开连接,因此不再有关闭校验的路径。
- `cli/join.mjs` 的连通性探测默认校验对端证书。自签 relay 用 `--ca <pem>` 显式信任;
  `--insecure` 是唯一的绕过方式,并且会在 stderr 明说已绕过。`probe` 对 IP 主机不再发送
  SNI(RFC 6066),改由证书的 IP SAN 匹配。
- 证据:`cli/join.spec.ts` 覆盖默认校验下自签 relay 被拒且不写配置、`--ca` 下真实握手成功、
  `--insecure` 成功并打印绕过提示。

## 未收口

- 推送的 account/scope 精确按键(见第 4 节)。
- `issue.reference` 只对"跨类型复用 commit"(create 的 commit 用于 reference)报冲突;两次
  reference 用同一 commit 指向不同 issue 时会各建一个会话。CLI 的稳定 commit 由目标推导,
  现有路径不会触发;要强制 §9 的内容冲突需给引用也记 commit。
- `relay-client` 对已放弃的群请求最多记住 256 条、每条约 5 分钟,过期即遗忘。在这段时间内若
  有人复用同一个请求 id,迟到的错误会归到新请求上;仓内所有请求 id 都是 randomUUID,该情形
  在现有路径上不可达。真正的逐请求取消仍是通道自己的超时。
- `acp-serve` 内真实 relay 的端到端用例(见第 1 节);新增用例只覆盖注册不可达的分支。
- 真实 Vikunja 实例与 webhook 签名未核验,仍只有本地 HTTP 替身。
- 设计第二批(模型执行:Session 映射、queue/steer、讨论与 comment 执行)未开始。
