# 审计与行为设计验证

输入源基线：5496e1e925e4bbe612d509488368003bd78880d6。
范围仅 docs/README/行为 graph；未修改产品代码、未启动/安装目标 daemon，不执行源码全量 gate。

## 静态 DAG 检查

每个命令均在本任务外置 worktree 独立执行，exit 0：

| 命令后缀（完整前缀 dagpipe graph validate docs/design/dagpipe/graphs/） | nodes / edges / waves |
|---|---|
| daemon-start.graph.json | 6 / 5 / 6 |
| agent-work.graph.json | 7 / 6 / 7 |
| provider-config.graph.json | 5 / 4 / 5 |
| console-observe.graph.json | 5 / 4 / 5 |
| session-request.graph.json | 5 / 4 / 5 |
| daemon-stop.graph.json | 5 / 4 / 5 |
| version-delivery.graph.json | 6 / 5 / 6 |

`dagpipe graph inspect docs/design/dagpipe/graphs/agent-work.graph.json`：exit 0，七个 operator@1 bindings 按顺序分七 waves；六条 ARC edges 与模型一致。
CLI 原输出明确：operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate。
本次没有 SDK registry/schema/effect compile 或执行 journal，不宣称运行时 DAGpipe 改造完成。

## 用户安装包布局观测

仓库现有 ignored 构建产物：`npm pack --dry-run --ignore-scripts --json` exit 0；name=agentteams，version=0.1.0，files=132，size=139754。
未包含 console.html、console-entry.js、browser.js。package files 仅 cli 与 generated/runtime-lib，与另一个 governance artifact producer 的 UI/static 布局不同。
仅证明当时已有产物的 pack manifest，不证明当前候选新 build/install 成功；后续 U1 必须从候选重建并离开源码树安装验收。

## 源码审计与历史限制

runLocalConfiguredWork 等待 internal.configuredWork，不发起新请求；agent-process sendSession 显式 UNSUPPORTED_OPERATION；cli-executor 固定两能力及容量；Console 运行入口要求独立 JSON。
以上结论为本轮源码调用链检查，不冒充本轮 live 网络/浏览器复现。历史 socket/provider evidence 原候选见审计正文，不升级成当前安装证据。

main 在开始时 clean，fetch 后 origin/main=基线。此次文档修改与 graph authoring 不要求 runtime build、安装、重启、移动端或公网回放。
