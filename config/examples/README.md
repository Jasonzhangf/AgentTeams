# D00 example daemon configs

These files are real inputs for `config/daemon-intent.spec.ts`; the spec parses
and compiles every file, so an example cannot drift from the v4 schema.

| File | Kind | Notes |
| --- | --- | --- |
| `agent-opencode.toml` | agent | OpenCode engine, one provider, two manual models, primary/backup binding. |
| `agent-dsh.toml` | agent | DSH engine, `openai-responses` provider, reasoning model. |
| `control.toml` | control | Loopback WebUI with auth, discovery server, one peer. |
| `registry.toml` | registry | Loopback listen with two admissions; reuses server/Relay. |

All credentials use placeholder references (`env:EXAMPLE_*`), and every `file:`
reference is resolved but never read during parse or compile. Do not put real
secrets in an example.

Schema, error and migration rules: [`docs/design/teams-acp-daemon-config-v4.md`](../../docs/design/teams-acp-daemon-config-v4.md).
