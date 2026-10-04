# f9c181f browser CLI snapshot format root repair

## 2026-10-04T18:33:59Z | baseline and owner confirmation | local source + CLI help | HEAD fce39c2073d100b49893182d2b74408825b67f14 | run real red

- Worktree is clean and exclusive at `/Volumes/Intel/playground/agentteams/f9c181f-camo-snapshot-20261004`.
- Development governance assigns browser CLI behavior to `cli-adapter/**`; the relevant Work graph keeps the existing browser operations unchanged.
- `/opt/homebrew/bin/camo` is version `0.4.10`.
- `camo snapshot --help` states that output is semantic JSON by default and that `--raw-dom` is required to return `html`/`htmlLength`.
- Current adapter source calls `snapshot --format json` without `--raw-dom` and then requires `snapshot.data.url` and `snapshot.data.html`.

## 2026-10-04T18:34:46Z | real Camo red reproduced | external raw log | HEAD fce39c20 + installed Camo 0.4.10 | make focused spec red

- Real public adapter consumer: `context.create -> navigate` reached the local HTTP page and returned the original URL.
- Direct semantic snapshot returned `data.format: semantic-json` with `data.tree.nodes` and no `data.html`.
- Direct raw snapshot with `--raw-dom` returned `data.format: raw-dom`, original URL, `htmlLength: 122`, and the complete marker HTML.
- Adapter snapshot failed with `PROTOCOL_ERROR: snapshot.data.html must be a non-empty string`.
- The consumer destroyed its own context and confirmed `state: stopped`.
- Raw evidence: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/f9c181f-camo-snapshot-20261004/red-probe.log`.

## 2026-10-04T18:36:04Z | focused red to green | local logs | candidate source after one-line fix | freeze candidate

- Focused spec before the fix: 1 failed, 5 passed; failure showed the missing `--raw-dom` argument.
- Focused adapter and executor tests after the fix: 2 files passed, 14 tests passed.
- Full `pnpm typecheck` passed.
- Real Camo adapter probe after the fix: original URL, complete HTML, marker present, `PROBE_STATUS=green`.
- The consumer destroyed its own context and confirmed `state: stopped`; Camo status reports no `f9c181f` profiles and no running `f9c181f` execution.
- Raw evidence: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/f9c181f-camo-snapshot-20261004/focused-red.log`, `focused-green.log`, `typecheck.log`, and `green-probe.log`.
- Candidate receipt path: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/f9c181f-camo-snapshot-20261004/candidate-receipt.json`.
