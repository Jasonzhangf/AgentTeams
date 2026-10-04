# U1 manifest follow-up run notes

Timing correction by the primary at 2026-10-04T09:28:47.183634Z: the author
used manual stage time labels, including future 09:30 labels. The table's
time labels are not reliable wall-clock evidence. Original notes and
provenance are preserved externally in the task receipt. Every outcome was
read back from the completed worker command stream and matching raw logs
at this primary observation time. Raw command order, hashes and outcomes
are authoritative. Log mtimes read back by the primary include artifact
smoke 09:23:28Z, installed smoke 09:23:43Z, SDK verify 09:24:12Z and cleanup
receipt 09:25:25Z. The corrected provenance timestamp means primary
confirmation, not command execution time.

| time/node | state | raw evidence | exact source/tree/package/env | next |
| --- | --- | --- | --- | --- |
| 2026-10-04T09:21:12Z / observe | confirmed | r3 review finding: `runtime/dagpipe` is declared but untracked; inherited staged tree `b6694c6e56efec1f7b0d71dec5661e0dc891ae5d` | worktree `/Volumes/Intel/playground/agentteams/u1-manifest-fix-20261004`; HEAD `dd4ffa9075b1fbc215e99070147865b4fa1495bb`; HOME `/Users/fanzhang` | add a real staged-receipt plus npm-pack assertion, then reproduce red before removing the declaration |
| 2026-10-04T09:21:26Z / red | reproduced | `red-declared-files.log.gz`: focused test failed at `declared base entry is missing from staged pack: runtime/dagpipe` | same tree; actual staged pack and actual `npm pack` file list; only the new assertion was unstaged | remove the nonexistent declaration from `package.json` and the expected list, then run green |
| 2026-10-04T09:22:00Z / fix | implemented | package manifest and focused expected list no longer declare `runtime/dagpipe`; final-mode failure untouched | same tree; metadata-only change | run the full focused package-install suite and capture green |
| 2026-10-04T09:22:36Z / focused-green | passed | `package-install-spec.log.gz`: 1 file, 12/12 tests passed, including real npm pack, isolated install, installed CLI/Console, and installed Relay/two-Agent restart | same tree; suite `beforeAll` rebuilt and staged the current inputs | run typecheck/build, refresh the staged base package, then collect durable public consumer and smoke receipts |
| 2026-10-04T09:26:00Z / development-gates | passed | `pnpm-typecheck.log.gz`, `pnpm-build.log.gz`, `package-artifact-base.log`, `artifact-smoke.log`, `runtime-smoke.log`; base package content `7aa1a77f...`, 169 files | same tree; Node v22.22.2, pnpm 10.31.0 | run durable package/installed consumers and AppSDK compile/verify |
| 2026-10-04T09:28:00Z / public-consumers | passed | `package-user-smoke.receipt.json`, `installed-runtime-smoke.receipt.json`; installed content hash `7aa1a77f...`, tarball `a44c7876...`, generations 1→2, owned PIDs changed, temp root removed | same tree; actual npm pack/install outside source tree; explicit installed receipt path | bind AppSDK identity and cleanup |
| 2026-10-04T09:30:00Z / appsdk | passed-for-development | `appsdk-compile.log`: artifact `sha256:21df5f30...`, source `sha256:04860223...`; `appsdk-verify.log`: exit 0, development_ready=true, delivery_not_evaluated | same tree; canonical `/Users/fanzhang/.cargo/bin/appsdk`, SHA256 `84a8f6f2...` | finalize provenance; primary owns review and integration |
| 2026-10-04T09:30:00Z / cleanup | passed | `cleanup-receipt.json`; all owned PIDs absent and temporary root removed | same tree; worktree intentionally retained for primary | hand off staged candidate |
