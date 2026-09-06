# RCC 4444 managed OpenCode live evidence

Date: 2026-09-06. Environment: local RCC managed service on
`127.0.0.1:4444`, installed OpenCode `1.18.23`, current main
`3be5f62` before governance-only map update.

## Direct RCC probe

```text
POST http://127.0.0.1:4444/v1/chat/completions
body: {"model":"gpt-5.5","messages":[{"role":"user","content":"Reply with exactly teams-rcc-probe"}],"stream":false}
HTTP 200
assistant: teams-rcc-probe
response model: gpt-5.6-sol
```

The requested model and the RCC routed response model differ; Teams records the
configured target and does not infer a new binding from the response.

## Managed OpenCode probe

Command:

```text
node --experimental-transform-types playground/rcc-live-probe-20260906.mjs
```

Observed output:

```json
{"sessionStatus":200,"messageStatus":200,"sessionId":"ses_f89effa21ffeUfqjJeCBTO72tJ","assistantText":"teams-rcc-teams-probe","effectiveRevision":1}
```

The probe started an isolated managed OpenCode child, created a real Session,
sent an explicit `{providerID:"rcc-4444",modelID:"gpt-5.5"}` target through the
OpenCode Session endpoint, and received the expected assistant text from RCC.
The child was stopped after the response and its temporary directory was
removed with bounded retry.

## Limits

This proves the RCC primary Session path only. It does not prove RCC tool or
approval flows, goaichat backup, automatic or hidden fallback, public NAT,
direct Agent-to-Agent transport, phone replay, or crash recovery.
