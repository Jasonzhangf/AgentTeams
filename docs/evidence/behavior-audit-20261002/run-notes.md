# 行为审计节点笔记

任务 owner：Desktop primary；范围：审计、行为模型、用户交付计划；禁止修改产品源码。
基线：5496e1e925e4bbe612d509488368003bd78880d6；分支 codex/behavior-dag-audit-20261002。
本任务资源：外置 worktree `/Volumes/Intel/playground/agentteams/behavior-dag-audit-20261002`；两个新建只读 GCM child；其原始日志保留到结论归档后删除。没有启动项目服务。

- 2026-10-02 / A0｜PASS：fetch 后 HEAD=origin/main，main clean，启动前仅根 worktree｜Git 实时输出｜上述基线｜审计入口和历史证据。
- 2026-10-02 / A1｜PASS：已读取五张架构 map、CLI、local-config/process、agent-process、Console、config、打包生产者；maps 中 implemented/design/partial 混杂，不能直接充当进度｜源码及历史 receipts，详见审计报告｜上述基线｜建立目标行为图，明确实现偏离。
- 2026-10-02 / A2｜已确认：work 读取 generation 绑定的 configuredWork；默认 executor 固定两种能力；Console 需要独立 JSON；provider 接受状态为独立 JSON store｜runtime/local-process.ts、runtime/agent-process.ts、agent-host/cli-executor.ts、runtime/console-process.md｜源码审计，不冒充新 live 验证｜整理用户收口范围。
- 2026-10-02 / A3｜PASS：npm pack dry-run 当前产物共 132 files，没有 console.html/console-entry.js/browser.js；这是已有产物布局检查，未做当前候选重建或安装｜package.json、scripts/package-artifact.mjs、npm pack --dry-run --ignore-scripts --json｜基线及根已有 ignored 构建产物｜计划统一用户安装包，不复用 governance artifact smoke 作为 CLI pack 证明。
- 2026-10-02 / MCPX｜限制：官方 capabilities/workspace 查询可用，18 个已注册 Workspace 无本仓库/本 worktree；本次不借其他项目 Session，使用本项目 CLI 记录检查与 Git 收口｜工具 structuredContent｜无 MCPX 项目执行证据｜不新增无关 runtime 治理。

历史 2026-09-14 验证只按其原候选和入口复用为历史证据。AppSDK development_ready 不等于 delivery_verified。后续节点在完成后追加。

- 2026-10-02 / A4｜PASS：七条目标行为 graph 均通过 dagpipe graph validate；Work graph inspect 确认七个 binding 与六边｜validation.md｜基线源码 + 本轮 graph v1｜检查中文语义、ARC 契约与失败状态，然后独立设计 review。
- 2026-10-02 / A5｜READY：现状审计、行为模型、用户交付计划已写；README 与旧 brief 已指向新入口｜docs/design/teams-behavior-*.md、docs/goals/teams-user-delivery-plan.md｜文档候选；无 runtime 修改｜收取 worker 审计，固定 candidate tree 并审查。
- 2026-10-02 / A6｜定向检查：五个入口文档的相对 Markdown links PASS、git diff --cached --check PASS。测试清单发现不存在的 work-ingress.spec.ts，已纠正为实际 agent-work-client.spec.ts；按最新用户约定显式补充黑盒交付准入｜计划与工具输出｜只改计划解释，七个 graph/模型/审计正文未变｜重新做文档路径检查；设计 review 绑定原 graph 内容，不把未检查的新产品实现计入 PASS。
- 2026-10-02 / Workers｜Console/config worker 已完成只读报告，事实与 primary 独立源码检查一致；不采纳其新增 editable JSON 的建议。Runtime worker 扩展到历史 diff 阅读，已超出本轮现状核对所需，由 primary 停止自己的 child PID 31151，不把它计作完成的独立审核｜worker-console-config.md；runtime 原始日志只用于诊断，待压缩归档后回收｜两者均未修改产品或启动服务｜保留已确认事实与取消原因，继续设计审查和文档交付。
- 2026-10-02 / A7｜文档收口：独立 review 的启动候选已改变，停止该任务，未取得 PASS；最新 codex-orchestrator 已读取；纯文档按针对性检查交付｜review-disposition.md、review-status.json、worker-disposition.md｜当前模型 v1，产品代码未改｜归档状态，提交/推送文档并清理本轮 worktree；产品开发先审最终设计。
