# U1 安装包窄设计 Run Notes

基线：`codex/u1-package-design-20261003`，base/origin/main `20051913b8145d176d50afdae563adb6737d2779`。

允许写入：`docs/design/teams-package-delivery.md`、`docs/evidence/u1-package-design-20261003/**`。

## 节点记录

2026-10-02T21:29:07-0700 / 锚定与输入读取 | 已确认设计范围仅限 U1 同包安装，不写产品代码；已读取项目 AGENTS、用户交付计划、D1 待审契约和 D2 探针结论 | 证据：本 worktree `AGENTS.md`、`docs/goals/teams-user-delivery-plan.md`、D1 `docs/design/teams-behavior-contracts.md`、D2 `docs/evidence/d2-sdk-probe-20261003/README.md`；输入版本为上述 base | 下一步：读取包、CLI 路径、Console/UI 构建与静态服务锚点

2026-10-02T21:31:00-0700 / 源码事实定位 | 当前用户包只发布 `cli` 与 `generated/runtime-lib`，治理 artifact 另复制到 `generated/modules/teams-source/lib`；正式 CLI 已有 init/start/status/stop/work；Console 尚未由 CLI 接线，`console-process` 依赖 JSON 的 staticRoot/uiRoot；D2 证明 SDK 为 Rust `pipeline_runtime 0.1.1` 且探针路径不可产品化 | 证据：`package.json`、`cli/agentteams.mjs`、`scripts/package-artifact.mjs`、`scripts/installed-runtime-smoke.mjs`、`runtime/console-process.ts`、`console-host/src/server.ts`、`console-host/package.json`、`ui/teams-console/package.json`、`.appsdk/project.json`、D2 README；输入仍为 base `20051913...` | 下一步：写唯一 pack root、构建/运行/验收与依赖边界

2026-10-02T21:34:00-0700 / 设计落盘 | 已建立唯一 staged pack root `generated/modules/teams-source/lib`，区分 U1 基础包与 D3 依赖的最终 SDK 同包；明确 runner/SDK 哈希、平台限制、BB01/BB14 正式 CLI 合同、共享文件串行顺序与未决 owner | 证据：`docs/design/teams-package-delivery.md`；输入为 base `20051913...`、tree `5ef1208691ca82f19e625f3f54622d497849879e` | 下一步：Markdown fence/link、源码路径与 `git diff --check` 检查

2026-10-02T21:35:27-0700 / 文档验证 | Markdown fence/link 与真实源码路径检查通过；`git diff --check` 退出 0，且两个新增文件的 `git diff --no-index --check` 无输出；未运行产品全量、编译或黑盒，符合本任务只写设计的边界 | 证据：本笔记；检查命令结果 `markdown-ok links=11 fences=28`、`source-anchors-ok`、`diff-check-exit=0`、`no-index-check-no-output`；输入仍为 base `20051913...` | 下一步：返回实际产物、检查结果与未决项

2026-10-02T21:36:41-0700 / 图名校正 | 当前项目 Work 图为 `docs/design/dagpipe/graphs/agent-work.graph.json`；`work-query.graph.json` 尚未落盘。设计已改为使用真实 Work 图名，并把查询图列为 D1/D3/U4 落盘依赖 | 证据：`rg --files docs/design/dagpipe/graphs`、`docs/design/teams-package-delivery.md` | 下一步：重跑最终文档检查

2026-10-02T21:38:19-0700 / AppSDK 真源缺口 | 当前 `.appsdk/project.json` 与 `scripts/artifact-smoke.mjs` 仍按旧扁平路径检查治理 artifact，与本设计 pack-root 布局不一致；已列 Primary+U1 重绑依赖，未改 map | 证据：`.appsdk/project.json` `artifact_paths`、`scripts/artifact-smoke.mjs`、本设计第 3/8/10 节 | 下一步：最终检查并返回

2026-10-02T21:41:16-0700 / 远端边界刷新 | `origin/main` 已推进到 `94b46334cd13e9fc7186c74b5206e70a0f429908`，新增 D1 行为契约与 `work-query.graph.json`；本树仍按要求绑定 base `20051913...`，未 fetch/rebase/merge/commit，设计已注明产品实现须从最新 main 重建并复制两张最新图 | 证据：`git rev-parse origin/main`、`git show --stat origin/main`、`git ls-tree -r origin/main docs/design/dagpipe/graphs`、origin/main 的 D1 run notes | 下一步：重跑最终文档检查

2026-10-02T21:41:54-0700 / D1 临时树回收 | 原 D1 worktree 路径已被其 owner 清理，原相对链接失效；设计关联输入已改为 `origin/main:docs/design/teams-behavior-contracts.md` 的 Git 对象引用，不再依赖临时路径 | 证据：`test -e d1.../teams-behavior-contracts.md` 为缺失、`git cat-file -e origin/main:docs/design/teams-behavior-contracts.md` 成功 | 下一步：最终检查

2026-10-02T21:43:00-0700 / 远端观察收口 | 最终只记录一次观察值：`origin/main=1b492fb2bd3f162d9ef79bba5571b30af13f2dd0`（含 `94b4633` D1 closeout）；本设计以指定 base 为输入，不把持续推进的远端 HEAD 当冻结候选 | 证据：`git log --oneline --max-count=4 origin/main`、本设计基线说明 | 下一步：最终检查并返回

2026-10-03 UTC / primary-candidate | Worker exit0、无 writer；组合最新 main1b492fb。Primary 修正 test_home 示例（避免 zsh home 特殊变量）、保留 private 本地包语义、版本源仅 root package，明确 U1 同时拥有 producer/artifact path/smoke 的最小原子改造范围 | 证据：Git、worker exit、设计diff；D1已PASS，D2 r2待审 | 下一步：定向文档检查，独立 U1 窄设计准入；不宣称产品已交付

2026-10-03 UTC / r2-first-divergence | 正式r2 exit0但controller FAIL：固定默认端口没有网络隔离；runner hash失败无零执行/副作用验收；SDK完整输入hash为P2 | 证据：.agent-collab/review/u1-package-design-20261003-r2/status.json及review.final.md；作者/审查PID均已missing，作者exit0 | 下一步：仅修同一设计候选，不编码或当PASS集成

2026-10-03 UTC / r3-intervention | 组合最新main55c8282；补U2系统动态端口及U7监听前后归属、三类runner失败副本和哨兵/真实副作用断言；SDK输入完整build receipt由D3唯一build owner生产；D1/D2已PASS事实与主线证据链接更新 | 证据：本设计§4/5/7、git diff；输入55c8282 | 下一步：针对性文档/图检查后独立r3审查；仍非产品安装通过

2026-10-03 UTC / r3-design-validation | Markdown相对链接/fence通过，端口/哨兵/零副作用/完整SDK身份/唯一build入口覆盖检查通过；version-delivery.graph.json validate PASS（6节点5边），git diff/cached diff --check PASS | 证据：本候选命令输出；输入55c8282 + 两允许文档 | 下一步：冻结staged tree后新独立r3审查；未跑产品build/E2E，纯设计适用性

2026-10-03 UTC / r3-first-divergence | 正式r3 FAIL两P1：missing-runner命令复用已删runtime的副本，先触发runtime缺失；构建示例仍直接rsync/cargo，与正文D3唯一builder冲突 | 证据：u1-package-design-20261003-r3正式result/status；精确tree87cc8eb | 下一步：修本候选全部同义引用，重新检查后新独立r4

2026-10-03 UTC / r4-intervention | runner-missing独立完整副本只删runner，明确排除runtime前置失败与零副作用；构建示例只调用D3实际候选build.mjs，读取binary/receipt核对后打包；template/generated manifest/lock与所有表述归唯一build owner，不另rsync/cargo | 证据：设计§4/7及实际D3 build.mjs公开stdout/API；输入main55c8282 | 下一步：定向一致性检查、冻结tree、r4独立审查；不修改D3产品源码

2026-10-03 UTC / r4-design-validation | 相对链接/fence及唯一build命令、独立完整runner副本/排除runtime前置失败的定向检查PASS；diff与cached diff --check PASS；图输入未变复用r3静态证据 | 证据：本候选检查输出；输入55c8282及两个允许文档 | 下一步：新独立r4审查，不跑无关全量
