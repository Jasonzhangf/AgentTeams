<!-- project-memory:v1 {"category":"knowledge","created_at":"2026-09-14T17:35:32.073452+00:00","id":"c5708f3-current-syah-provider-20260914","importance":0,"memory_level":3,"review_evidence":[],"review_status":"unreviewed","source_refs":[],"tags":["agentteams","ai-reviewed","human-unreviewed","opencode","provider"],"updated_at":"2026-09-14T17:35:32.073452+00:00"} -->

# Current SHA provider OpenCode replay

On AgentTeams main source 18279c48c26af725e98de7194c59d600b115f77a, a real local TLS Relay and Agent refreshed RCC and GoAIChat provider instances, applied config, and read acceptedRevision=5/effectiveRevision=5 again after runtime stop/start. RCC /v1/models was reachable with an explicit empty catalog; configured manual gpt-5.5 remained an explicit target. Credentialed GoAIChat returned 18 entries including qwen3.8-max. Managed OpenCode independently dispatched both targets with HTTP 200. No automatic failover or response-model inference was used. Evidence: docs/evidence/c5708f3-current-syah-live-20260914/candidate-receipt.md and review-receipt.md; remote main receipt 9960ab56dcd9a8e341e7ab4cfba4deba6aed156c.
<!-- project-memory:end -->
