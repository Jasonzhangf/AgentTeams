# Provider closure corrected acceptance (2026-10-29)

## Result

PASS: 32/32 checks passed on candidate `config-readonly-ui@0bb9c97`.

- Candidate: `/Volumes/Intel/playground/agentteams/config-readonly-ui`
- Commit: `0bb9c97fcd5a20e1a4d807234f1f0d240efabf2f`
- Real RCC endpoint: `http://127.0.0.1:4444/v1`
- Real model: `inferai.deepseek-v4.1-flash`
- Receipt: `evidence/results.json`
- Console log: `run.log`
- Exit code: `0`

The previous 30/32 result was a harness attribution defect, not a product
regression. The corrected proxy classifies title generation and the main prompt
from request-body evidence before consuming any fault script. Title requests
pass to the upstream provider and never consume the 401/429 script.

## Harness correction

Source copied from:

`/Volumes/Intel/playground/agentteams/.worker-runs/webui-provider-closure-candidate-0bb9c97-20261029/evidence/provider-closure.mjs`

Corrected harness:

`evidence/provider-closure.mjs`

Classification uses both facts below and records both in every proxy hit:

- `toolCount === 0`
- system prompt contains `title generator`

Each hit records `role`, `status`, `toolCount`, `systemHead`, `titleByTools`,
`titleBySystem`, and `lastUser`. The `lastUser` field is evidence only; it does
not determine the role.

## Assert 4a: bounded 429 retry

Main prompt hit sequence:

| role | status | tools | systemHead |
| --- | ---: | ---: | --- |
| title | 200 | 0 | `You are a title generator. You output ONLY a thread title. Nothing else.` |
| main | 429 | 10 | `You are opencode, an interactive CLI tool that helps users with software engineering tasks.` |
| main | 429 | 10 | `You are opencode, an interactive CLI tool that helps users with software engineering tasks.` |
| main | 200 | 10 | `You are opencode, an interactive CLI tool that helps users with software engineering tasks.` |

Asserted values:

- Main hits: `3`
- Main status sequence: `429,429,200`
- Final state: `completed`
- Scripted main attempts: `3`

The title request was separately recorded as `200` with `toolCount=0` and both
title signals true. It did not consume either 429.

## Assert 4b: 401 is terminal, no replay

Hit sequence:

| role | status | tools | systemHead |
| --- | ---: | ---: | --- |
| title | 200 | 0 | `You are a title generator. You output ONLY a thread title. Nothing else.` |
| main | 401 | 10 | `You are opencode, an interactive CLI tool that helps users with software engineering tasks.` |

Asserted values:

- Main hits: `1`
- Main status sequence: `401`
- Scripted main attempts: `1`
- ACP final state: `failed`
- Final error: `{"name":"UnknownError","data":{"code":"-32603","message":"Internal error: invalid api key"}}`
- No second main request was observed.

The projected provider endpoint was the active 401 proxy:
`http://127.0.0.1:49158/v1`. `chatAttemptsBeforeSend` was `0`.

## Remaining checks

The other 30 checks passed unchanged:

- Real RCC 4444 model catalog and real `inferai.deepseek-v4.1-flash` turn.
- Real Chrome/CDP Console rendering and Agent discovery.
- Settings drawer is read-only; no provider, binding, apply, or refresh write
  controls.
- Agent detail drawer is read-only.
- `config.putProvider`, `config.bindModel`, and `config.apply` return
  `UNSUPPORTED_OPERATION`.
- `config.refreshModels` returns `UNSUPPORTED_OPERATION` at the control API;
  the localized hint remains client-side.
- Control, agent, OpenCode child, and Chrome were started with explicit PIDs.

Screenshots:

- `evidence/assert1-discovery.png`
- `evidence/assert2-settings.png`
- `evidence/assert2-detail.png`

The three PNGs were opened and visually checked as non-empty Console captures.

## Cleanup

`evidence/results.json#cleanup` reports `clean: true` and
`rootRemoved: true`. Every tracked PID returned `aliveAfterKill0: false`.

The live PIDs were stopped with explicit SIGTERM and checked with
`process.kill(pid, 0)`. The cleanup receipt includes Chrome, control, agent,
and OpenCode child PIDs, including retired instances from the two proxy rebinds.
No `pc-blackbox` process, worker OpenCode child, or worker control/agent daemon
remained. No `pkill`, `killall`, `xargs kill`, or command-substitution kill was
used.

## Read-only boundary

- `/Volumes/extension/code/AgentTeams` remained at
  `b7236b2a4dad0308e2769011d71effc0c0bad543` with a clean `git status`.
- `config-readonly-ui` remained at
  `0bb9c97fcd5a20e1a4d807234f1f0d240efabf2f` with a clean `git status`
  (`ahead 1` relative to `origin/main`).
- No product source file, commit, push, worktree, or dependency state was
  changed.
- The candidate's existing built artifacts were reused for the harness.
- No `goaichat` was used. Real inference went only to RCC 4444. The local fault
  proxy was used only for the deterministic assert4a/assert4b cases.
