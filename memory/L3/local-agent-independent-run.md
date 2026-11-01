<!-- project-memory:v1 {"category":"plan","created_at":"2026-11-01T15:17:40.556433+00:00","id":"local-agent-independent-run","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["agentteams","independent","local","no-peers","non-loopback","single-daemon"],"updated_at":"2026-11-01T15:17:40.556433+00:00"} -->

# 本机 agent 独立运行：非回环监听、无 peer 组队、每配置单 daemon

用户 2026-11-01 裁决：本机多个 agent 各自独立运行，不互相组队，也不使用 127.0.0.1 回环监听。每个 agent 一份 v4 配置，各自启动一个 daemon，监听自己的非回环地址和端口（本机为 192.168.0.3），配置中不写 [peers]，也不放对方准入。真实验收：registry + reasoner-a/reasoner-b 两 daemon 监听 192.168.0.3:7443/7445，双方 acp-history.json 记录同一 connection.negotiated（connectionId=ea27b40f-9957-4746-8056-aef9fa3033aa，source=reasoner-a/peer，target=reasoner-b/master，targetCapabilitiesRevision=2）与 channel.opened，connection.failed=0；回环 127.0.0.1 监听时 classifyServeListener 归为 local 只开明文 ACP，不产生 Teams 组队记录，故组队必须用非回环。与 David 2026-10-28 单实例边界裁决一致：唯一性键 (daemonKind, daemonId, dataDirectory)，不同配置不同 dataDirectory 必须并发运行，无跨配置全局锁。本裁决属于用户使用模型，不改变代码。
<!-- project-memory:end -->
