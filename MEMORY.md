# Teams Project Memory

- 2026-08-31: Teams 的唯一 owner 边界已确定：network owns link configuration/transport/health；config owns shared runtime config/version/sync；server owns deployment/listener/server-side connection registry/account-permission admission；runtime composes daemon and network lifecycles；agent remains network-agnostic；DSH/OpenCode use separate host adapters.
- 2026-08-31: Bootstrap Link Config 必须先于 Shared Runtime Config；控制服务器只保存 identity、permission、discovery、config、audit、routing key，不保存 Session 消息、tool 结果或 approval body。
- 2026-08-31: AppSDK 0.1.6 的 `.appsdk/maps/` 是 SDK canonical governance surface，Teams 业务架构地图放在 `docs/architecture/`，避免触发 canonical map mismatch。
- 2026-08-31: Teams 详细设计冻结五个主入口的定位分工：Topology=物理位置，Conversations=时间，Notifications=重要性，Search=内容，Memory=长期上下文；Settings 由 gear 进入，不增加第六个 Mobile 入口。静态 HTML 是 UI reference fixture，runtime 实现必须复用 DSH Conversation owner 并保持 DSH/OpenCode adapter 分离。
- 2026-08-31: Teams 控制协议 v1 不做 Machine pairing，使用可选 shared API key/token 无状态一致性校验；Relation 是 consumer/provider 双边 capability-use report，server 汇总双方报告生成 graph；Console Hub 是本机 Teams Federation Host plugin 聚合层；Mobile 允许连接、Agent provider/model 和审批权限配置；配置冲突使用 revision compare-and-swap。
- 2026-08-31: Teams implementation-ready defaults are frozen: Teams stores only opaque credential references, Host owns canonical Machine/Agent names while Console aliases remain local projections, and capability-use reports heartbeat every 30s with a 90s freshness TTL; expiry projects `stale` and retains history.
