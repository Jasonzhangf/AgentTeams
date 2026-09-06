<!-- project-memory:v1 {"category":"lesson","created_at":"2026-09-06T05:01:44.797787+00:00","id":"p0-explicit-session-20260906","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["ai-reviewed","human-unreviewed","session"],"updated_at":"2026-09-06T05:01:44.797787+00:00"} -->

# 当前Session不能由列表顺序推断

基线7d171e8。Console曾用首个Session做当前投影和原型消息目标；3个红测复现。现在仅从Agent Host只读readCurrentSession读取明确选择，未知不猜测、失效/读取失败显式报错，投影和dispatch共用唯一校验。完整pnpm verify通过33文件143测试、类型检查、构建、AppSDK与编译HTTP冒烟；真实Console HTTP配本地上游fixture证明第二项选中、第一项不误发，选择未知后无新增prompt。docs/evidence/p0-session-20260906/review.md为主任务事实审核，标记尚无人类复核；真实daemon绑定、OpenCode推理、手机/跨设备验收及本候选提交清理尚未完成。
<!-- project-memory:end -->
