<!-- project-memory:v1 {"category":"lesson","created_at":"2026-09-06T04:47:30.922305+00:00","id":"p0-business-json-20260906","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["ai-reviewed","human-unreviewed","protocol"],"updated_at":"2026-09-06T04:47:30.922305+00:00"} -->

# P0业务JSON保真与外层控制边界

基线dba3dd6。协议层曾按字段名黑名单误拒绝合法业务JSON，Agent消息递归还拒绝数组；红测16失败/9通过确认首次偏离。修复复用control-protocol/json-value.ts保留合法JSON，在声明的外层字段校验控制位置；业务payload不提供缺失generation。pnpm verify通过33文件142测试、类型检查、构建、Guidance/AppSDK compile/verify及编译Console HTTP入口。HTTP成功通过payload校验后停在故意缺失的relation授权，不代表provider或跨设备work成功。证据docs/evidence/p0-payload-20260906/。主任务已复核事实；尚未经人类复核，提交合并和工作树关闭待完成，Session明确选择和N2仍待开发。
<!-- project-memory:end -->
