# D00 example daemon configs

These files are real inputs for `config/daemon-intent.spec.ts`; the spec parses
and compiles every file, so an example cannot drift from the v4 schema.

| File | Kind | Notes |
| --- | --- | --- |
Local provider endpoints and models use the real local RouteCodex RCC server on
port 4444 (see `/Volumes/extension/.rcc/config.toml`
`[servers.routecodex_v3_4444]`). The agent examples point `apiBaseUrl` at
`http://127.0.0.1:4444/v1` with no credential reference, because the local RCC
server accepts unauthenticated loopback requests. The two known models there are
`gpt-5.5` (primary) and `kk.glm-5.3-flash` (backup). Keep discovery/peer
endpoints on `127.0.0.1` to match the loopback registry/agent examples.

To run against a different endpoint or provider, override the provider/peer
values; never embed a real secret here.

| `agent-opencode.toml` | agent | OpenCode engine, local RCC 4444 provider, two manual models, primary/backup binding. |
| `agent-dsh.toml` | agent | DSH engine, `openai-responses` provider over local RCC 4444, reasoning model. |
| `control.toml` | control | Loopback WebUI with auth, loopback discovery server, one loopback peer. |
| `registry.toml` | registry | Loopback listen with two admissions; reuses server/Relay. |

All credentials use placeholder references (`env:EXAMPLE_*`), and every `file:`
reference is resolved but never read during parse or compile. Do not put real
secrets in an example.

Schema, error and migration rules: [`docs/design/teams-acp-daemon-config-v4.md`](../../docs/design/teams-acp-daemon-config-v4.md).
