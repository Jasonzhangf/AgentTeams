# AgentTeams 开发计划入口

当前本地用户 MVP 的任务、依赖、owner、可并发范围与 BB01–BB14 完成条件，统一由
[用户交付计划](teams-user-delivery-plan.md)维护。本入口不再保留已被接替的 G0/L1–L5
或 relay-first 派单表，也不从旧计划推断当前任务、worker 或 worktree 状态。

Desktop 主任务的调度、集成、阶段记忆与资源责任见
[长程交付任务](teams-long-running-delivery.md)。worker 的启动方式以当前
`codex-orchestrator` 为准；独立开发不要求 Collab 注册。

适用验证、失败重入与有效证据复用见[开发管控](../development-governance.md)。
本入口不再复制交付闭环或要求每次恢复重跑全量校验。

公网 Relay、NAT/STUN、direct、手机及后续部署范围也由用户交付计划维护，
不作为本地 MVP 的隐含前置。迁移基准、旧实施顺序与历史审批保留在 Git 历史及
原始交付证据中；历史记录不代表当前用户路径已交付。
