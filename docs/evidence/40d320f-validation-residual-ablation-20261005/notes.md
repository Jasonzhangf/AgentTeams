# 40d320f 校验残留消融

Owner：Desktop 主任务；实施者：独立 GCM worker。
候选已组合 origin/main 7739da440b52c7335a6662e32c0bccb29b6acb7d。
状态：candidate / awaiting-baseline-repair；尚未 review、merge、push 或关闭。

删除退役 DSH adapter、其专属测试及 separator 文本检查；移除 Vitest/module
source/regression 的失效路径。该实现只被退役测试消费，不进入构建或安装包。
删除 Agent 的 class/export-function 形式限制及 UI 旧文案、函数计数断言。
保留跨 owner 导入、凭据、控制与业务分离、显式 action 和可访问性检查。
SDK minimum_test_count=304 未调整，历史记录未重写。
SDK module registry 中的旧 DSH 归属 glob 无消费者，待官方 map 刷新收口。

实施者：受影响68/68 PASS、typecheck0、既有交付图 validate0。
DOM 证据使用真正的 Chromium headless shell；系统 Chrome 在 child sandbox
中失败，未以源码断言代替 DOM。父任务实际默认 Chrome 回归也通过该用例。

组合后首次全量553 PASS/23pending（package suite 初始化失败）；
package 独立重放24/24 PASS；恢复全量575 PASS/1FAIL/0pending。
当前失败是未修改的 local-two-agent 清理：ENOTEMPTY，最后留下 daemon-status.json。
已按 c520894 独立建档、独立工作树诊断；不跳过、不混入本次消融、不声明全量 PASS。

原始笔记/失败报告/恢复报告及命令输出保存在本任务独占
`$HOME/.codex/task-evidence/agentteams/receipts/40d320f-validation-residual-ablation-20261005/`；
author-raw.tgz 保存原始 worker 日志。无消费者的重复 JSON 摘要已移出源码。
worker 已退出，660MB 临时 store/浏览器材料与隔离 CODEX_HOME 已回收；
失败 fixture 的残留状态已复制并 cmp 核对，原目录已回收，未把清理冒充 bug 修复。
下一步：收口 c520894，补受影响门禁，再独立 review 和交付本候选。
细粒度 gate 重入继续由已有 3fd009a 跟踪；本单元不宣称其完成。
