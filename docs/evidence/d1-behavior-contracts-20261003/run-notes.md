# D1 行为契约阶段记录

Owner：本目标 Desktop primary。Base：20051913b8145d176d50afdae563adb6737d2779。
Worktree：/Volumes/Intel/playground/agentteams/d1-behavior-contracts-20261003；branch：codex/d1-behavior-contracts-20261003。
范围：行为模型/契约、Work submit/query graph、五个 architecture maps、当前交付计划/提示词一致性与本目录证据；不修改产品。
清理终点：精确设计候选通过独立审查、提交集成并推送，保存证据后移除本树/分支；未启动产品进程。

- 2026-10-03 / baseline｜main clean、仅根树、fetch 后 origin/main 同 base；活跃目标已存在，不新建 goal｜Git/get_goal 回执｜base 同上｜创建 D1、D2 独占树。
- 2026-10-03 / observe-public-boundary｜AgentWorkClient 公开 findProvider/open，channel propose/request/get/close/dispose；request 内 provider 才 allocation/execute/record。CLI 新请求到已登录 receiver 缺边，launcher 已有 child IPC｜runtime/agent-work-client.ts、agent-host/work-host.ts、runtime/local-supervisor.ts、agent-process.ts｜源码只读｜修图与入口设计，不制造远端 API。
- 2026-10-03 / model｜候选完成：七对象事件/守卫/终点，具体 Work ARC；Work v2 五节点公开边界；SDK per-execution runner 与 typed host port；其他六图静态治理；U2/U6 细契约仍须各自编码前补审｜docs/design/teams-behavior-contracts.md、model、graph、architecture maps｜设计候选，未准入｜静态验证并合并 D2 探针事实后独立 design review。
- 2026-10-03 / sdk-probe-dispatch｜已启动新建 GCM child，execution handle 11915；独占 D2 evidence scope，无产品写权限，无父 transcript｜parent task-evidence prompt/events；D2 worktree｜SDK 0.1.1 与 cargo/codex 可用｜等待实际 consumer 正反验证。
- 2026-10-03T03:46:22Z / static-validation｜PASS：Work v2 五节点四边、单源单汇；inspect 与五 Operator 公开映射匹配；无 selector strip；五 maps JSON 可解析且 ID 唯一；七对象契约与 Markdown fences 覆盖，diff --check 无错｜本轮 dagpipe/Python/Git 回执｜仅设计文件，无产品行为变化｜D1 独立文档设计审查；D2 仍单独待验证，D1 PASS 不开放产品编码。
- 2026-10-03 / review-r1｜FAIL：两条 P1，原请求查询缺图/maps 绑定，topology gate 声明超过实际命令覆盖；AppSDK `ed0bada` open｜.agent-collab/review/d1-behavior-design-20261003-r1/review.final.md 与 status.json｜旧 staged tree 1fb4fc6c9913a8c0b615690239ddc57d61bfb3b5｜修订后定向检查，新独立 r2 review。
- 2026-10-03 / revision-r2｜candidate：新增独立 B8 get 查询图；补契约、function/mainline/resource maps，gate 限定验证 submit/query；更新已有计划和 goal 提示词的八图分类/BB04,07,11/当前 gap｜本候选 docs/design、architecture、goals｜D2 worker 已产八例报告，未替代 primary 复核或产品 BB11；U2 设计仍未完成｜targeted checks 后冻结精确 tree。
- 2026-10-03 / revision-validation｜PASS：submit 5节点4边，query 4节点3边；两图 validate/inspect；maps JSON/ID、Operator 契约绑定、Markdown fences/相对链接与 diff-check 通过｜本轮 CLI 回执｜base 同上、纯设计变更；MCPX capabilities/workspace 已查，无 AgentTeams workspace，使用项目 CLI，不使用其他项目 session｜暂存 allowlist 后新独立 r2 审查，候选冻结。
