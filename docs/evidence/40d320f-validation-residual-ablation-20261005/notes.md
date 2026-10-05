# 40d320f 校验残留消融

Owner：Desktop 主任务；实施者：独立 GCM worker。
候选已组合 origin/main 7739da440b52c7335a6662e32c0bccb29b6acb7d，
随后 rebase 至集成基线 6252db854c2bd8d63a100a051f76cfaf88fbbbe5。
状态：candidate / awaiting-review。

删除退役 DSH adapter、其专属测试及 separator 文本检查；移除 Vitest/module
source/regression 的失效路径。该实现只被退役测试消费，不进入构建或安装包。
删除 Agent 的 class/export-function 形式限制及 UI 旧文案、函数计数断言。
保留跨 owner 导入、凭据、控制与业务分离、显式 action 和可访问性检查。
SDK minimum_test_count=304 未调整，历史记录未重写。
SDK module registry 中的退役 DSH 归属 glob 已随本消融一并移除。
separator 断言随退役 DSH adapter 整体消融；OpenCode 契约由
opencode-adapter/tests/index.spec.ts 保留（PluginInput/Hooks、SDK info、
notification projection），verification-map 不再声明已删除的 ClientContext/Slot
负例。

实施者：受影响68/68 PASS、typecheck0、既有交付图 validate0。
DOM 证据使用真正的 Chromium headless shell；系统 Chrome 在 child sandbox
中失败，未以源码断言代替 DOM。父任务实际默认 Chrome 回归也通过该用例。

候选 66cc94d52d7eceef42248a426485d325fd19e6da 的宿主全量回归通过：
exit 0，80/80 test files、576/576 tests、0 failed、0 pending。
该候选只包含消融代码与失效路径删除。

review r1 之后追加 commit dd52602234c0a77d578e68cc95490039793a22ee，只改
evidence notes、verification-map 措辞与 SDK module registry 的退役 glob；
未触达 runtime、测试、依赖、构建脚本或产物输入形状。
精确候选验证在 review 后运行，绑定到最终交付 commit 的外部 receipt：
`$HOME/.codex/task-evidence/agentteams/receipts/40d320f-validation-residual-ablation-20261005/exact-candidate-verify.json`。
该 receipt 的 `candidate.head_commit` 与本文件所属 commit 一致，并记录全量回归
与官方 appsdk verify 的 exit、计数与 receipt 文件身份。

此前的 575 PASS/1FAIL 是 c520894 修复落地前的 baseline 失败（local-two-agent
ENOTEMPTY），已由 c520894 独立修复并合入；本消融不混入该修复、不跳过、不重写历史。

原始笔记/失败报告/恢复报告及命令输出保存在本任务独占
`$HOME/.codex/task-evidence/agentteams/receipts/40d320f-validation-residual-ablation-20261005/`；
author-raw.tgz 保存原始 worker 日志。无消费者的重复 JSON 摘要已移出源码。
worker 已退出，660MB 临时 store/浏览器材料与隔离 CODEX_HOME 已回收；
失败 fixture 的残留状态已复制并 cmp 核对，原目录已回收，未把清理冒充 bug 修复。
下一步：收口 c520894，补受影响门禁，再独立 review 和交付本候选。
细粒度 gate 重入继续由已有 3fd009a 跟踪；本单元不宣称其完成。
