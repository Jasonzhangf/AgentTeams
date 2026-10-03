# 只读 worker 收口

两个 child 均使用新建 `codex exec --profile gcm --sandbox read-only --ephemeral`，独立当前任务合同，无 Collab 或外部 Master。

- Console/config child 产出 `worker-console-config.md`。Primary 复核其事实：TOML openCode.configFile 只是引用，daemon 使用 JSON config store；Console transport 已接但 sendSession 返回不支持；历史 provider 回放使用手写 JSON/harness，未涵盖用户 TOML/CLI/UI。建议继续新增 editable JSON 与本轮单一用户真源目标冲突，不采纳。
- Runtime child 阅读当前 runtime/CLI/Work 及历史 diff，未产出 final。Primary 已自行沿当前入口确认相关事实，停止此已扩展到非必要历史分析的 child PID 31151；不能将其计作完成审核或 PASS。
- 进程核对：`ps -p 31134,31151,31845,31901 -o pid,stat,etime` 仅输出表头，四个本任务 child/wrapper PID 已不在。
- 无 child 修改产品代码，无本轮 target daemon/listener/port 或安装产物。
- 两份 stdout 原始 log 是本任务临时资源；结论与 worker final 已归档后删除，避免进入产品候选或扩大 review 搜索范围。没有删除既有项目证据。
