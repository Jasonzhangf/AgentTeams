<!-- project-memory:v1 {"category":"path","created_at":"2026-11-01T15:36:19.344335+00:00","id":"symbol-exploration-prefer-nn-code","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["agentteams","call-chain","javascript","nn-code","symbol-exploration","typescript"],"updated_at":"2026-11-01T15:36:19.344335+00:00"} -->

# 符号探索优先使用全局 nn-code Skill

AgentTeams 排障、审计流程或追踪 TypeScript/JavaScript 调用关系时，已知入口函数后继续查找被调用方优先使用全局 nn-code Skill（`nn-code calls`），不默认用多轮 rg/sed 逐层展开；仅在入口或定义尚未知时使用精确搜索，获得入口后切回 nn-code。优化衡量覆盖完整模型调用过程（组织命令、等待结果和下一轮推理的往返耗时），不只比较单条命令执行耗时。适用语言、动态调用和未解析结果按该 Skill 的实际能力与静态边界处理；不把未解析关系猜成已确认关系。发现结果遗漏、错误或执行异常时，按该 Skill 的问题反馈流程处理并报告 bug；不得将手工补齐的结果冒称为工具输出。规则来源：项目 AGENTS.md「符号探索」节，提交 245cbcf。审计样本：nn-code calls 追踪 runtime/acp-serve.ts startAcpServeLocked 得到 28 nodes / 33 edges；startAcpServe 是委托包装，回调体为静态边界，审计时应直接以真实实现入口追踪。
<!-- project-memory:end -->
