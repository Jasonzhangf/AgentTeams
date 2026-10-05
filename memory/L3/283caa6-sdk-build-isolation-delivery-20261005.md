<!-- project-memory:v1 {"category":"lesson","created_at":"2026-10-05T01:16:10.517908+00:00","id":"283caa6-sdk-build-isolation-delivery-20261005","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["283caa6","ai-reviewed","dagpipe","human-unreviewed"],"updated_at":"2026-10-05T01:16:10.517908+00:00"} -->

# DAGpipe 并发构建目录隔离已交付 283caa6

根因：两个公开 buildRunner 消费者删除共享 .build/current，导致 Cargo ENOENT/ENOTEMPTY 及保留产物失效。修复在唯一 builder 使用 stdlib mkdtemp 创建每次调用的独占目录，保持 API/receipt 哈希契约；成功产物由 caller/worktree 生命周期回收。真实独立 native 双构建先 RED 后 GREEN，并通过两个 runner 的公开 compile 与默认文件并发 23 用例。fix/main/remote=11ddbdda53ca7914bd1a15d2da800ffcbd9e470f，tree=b54ce38a2336cb275ef6557cb63b9c6b0085f97e；独立 r2 PASS/有效 final/exit0；实际提交准入557全部通过、installed BASE generation1→2；干净集成在相同 SHA 再验23/type/compile/smoke/verify，push读回一致。两个自有 worktree/branch/HOME已回收，2286证据/产物文件归档内容及 SHA 已核实。证据目录：/Users/fanzhang/.codex/task-evidence/agentteams/receipts/283caa6-integration-20261005，integration-push-receipt.json、cleanup-receipt.json 和 memory-fact-review.json。U3 服务、最终 SDK 安装包与安装后 CLI Work 仍待交付。
<!-- project-memory:end -->
