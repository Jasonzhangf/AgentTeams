# D2 SDK host-callback probe

Status: capability probe PASS for the exact candidate in this directory. The
checked-in source has no machine-specific SDK path. A build-time entry resolves
the SDK from `dagpipe sdk path`, writes an isolated manifest and lock, verifies
the resolved `pipeline_runtime` package, and binds the runner binary to a
receipt before any runtime case starts.

This is not product Work black-box evidence, a portable product build, or
evidence that closes the Teams delivery goal.

## What was proved

The Node parent process starts one Rust runner. The runner uses the installed
`pipeline_runtime 0.1.1` SDK to parse a graph, register two Operators, compile
the graph, and run it with `Runtime::run`.

The first Operator sends one JSON-lines `host.call` to the already-running Node
parent over stdout. The parent validates control correlation, identity, and
operation, performs a real `readFile` on this probe's own input file, and
returns `host.result` or `host.error` over stdin. The second Operator is pure
and returns the first result. SDK Runtime controls node order; Node does not
run a second graph or sort nodes.

Control and business fields are separate at every host boundary:

```json
{
  "type": "host.call",
  "control": {
    "request_id": "d2-probe-execution/first-host-read/1",
    "operation": "host.read_file",
    "operator": "d2.host_read",
    "node_id": "first-host-read",
    "identity": {
      "project_id": "agentteams-d2-probe",
      "graph_id": "d2_sdk_host_probe",
      "graph_version": "1",
      "execution_id": "d2-probe-execution",
      "attempt_id": "1"
    }
  },
  "business": {
    "path": "<absolute path to input-A.txt or input-B.txt>"
  }
}
```

The journal is evidence only. It is not used to reconstruct control state or
business results.

## Exact commands

Run from the worktree root. `build.mjs` is the only supported build entry; it
removes and recreates `docs/evidence/d2-sdk-probe-20261003/.build/current`,
copies the tracked runner source and lock into it, and writes the generated
manifest there.

```sh
dagpipe sdk path
node docs/evidence/d2-sdk-probe-20261003/build.mjs
node docs/evidence/d2-sdk-probe-20261003/host/host.mjs \
  --runner "$(realpath docs/evidence/d2-sdk-probe-20261003/.build/current/target/debug/probe)" \
  --receipt docs/evidence/d2-sdk-probe-20261003/results/build-receipt.json \
  --results docs/evidence/d2-sdk-probe-20261003/results/results.json
```

The driver exits nonzero on a receipt/input/artifact mismatch before spawning
the runner, or if any exact case assertion fails. Its generated report is
`results/results.json`; the build receipt is
`results/build-receipt.json`.

## Build resolution and receipt

`runner/Cargo.toml.template` is checked in without a machine path. The build
entry runs `dagpipe sdk path`, requires one absolute existing SDK directory,
and requires that `cargo metadata --no-deps` resolves exactly one
`pipeline_runtime` package there. It then writes the SDK path and exact
`pipeline_runtime` version into `.build/current/Cargo.toml`, copies
`runner/Cargo.lock`, and runs `cargo metadata --locked` plus
`cargo build --locked`.

Before emitting a receipt, the build entry requires the resolved package name,
version, manifest path, and local path source to match the SDK directory. It
also refuses to continue rather than silently accepting an unknown package,
missing source, changed lock, or cargo-resolved path.

The receipt binds the exact build entry, driver, probe source, template, lock,
fixture hashes, SDK manifest and source hashes, resolved package identity,
toolchain identity, generated manifest/lock, and the runner binary path, size,
and SHA-256. Generated `.build/current` content is disposable output, not a
second editable source. `host.mjs` verifies the receipt's source and current
binary facts before it spawns the runner; runtime SDK identity is read from the
receipt, not from a second SDK lookup.

## Cases and observed results

| Case | Observed result |
|---|---|
| `normal-a` | One host call; Node reads `input-A.txt`; output content is exactly `marker=A\n`; journal schedule and completion order are `first-host-read`, `second-pure-output`. |
| `normal-b` | One host call; Node reads `input-B.txt`; output content is exactly `marker=B\n`; the same SDK-controlled order is observed. |
| `object-extra-field` | `ValueType::Object` accepts the input with an extra nested field; the host call still returns `marker=A\n`. No Record schema is claimed. |
| `field-missing` | SDK Object shape passes, then the Operator rejects the missing business field with `business.path must be a non-empty string`; there are zero host calls. |
| `compile-missing-operator` | Compile rejects `d2.missing_operator@1` before Runtime; there are zero host calls. |
| `compile-missing-effects` | Compile rejects missing capability `d2.host.read` before Runtime; there are zero host calls. |
| `host-error` | `host.error` becomes an Operator runtime failure with the exact host message; no output is produced and the journal ends in `execution_failed`. |
| `host-eof` | Parent EOF before a response becomes `host EOF before host.result/host.error`; no output is produced and the journal ends in `execution_failed`. |

The exact assertions cover exit status, one final frame, empty stderr, host-call
count, compiled graph identity, receipt-backed SDK identity, output key and
payload, SDK node schedule order, SDK node completion order, journal terminal
event, and error kind/message. Exit code alone is never the PASS criterion.

Two deterministic negative checks mutate only in-memory receipt copies: the
artifact SHA-256 and an SDK source SHA-256. Each must be rejected and must
leave `runnerSpawns` and `hostCalls` at zero.

## SDK identity

Observed from the installed SDK and recorded in `results/build-receipt.json`,
then consumed by `results/results.json`:

| Fact | Value |
|---|---|
| Crate | `pipeline_runtime` |
| Version | `0.1.1` |
| Path | Resolved at build time by `dagpipe sdk path` and recorded in the receipt |
| `src/lib.rs` SHA-256 | `81f7a5051f6d5420f325cf982d1c13b9b1c5e080ff788fccc7c8983ed348c89a` |
| `src/bin/dagpipe.rs` SHA-256 | `a212d0ad96f1d19a90ee94fc4fad7fc51445715a55d2014d9da72bf34dfc4483` |
| `Cargo.toml` SHA-256 | `2a3ef4936288b80f369cc740f3d7254c4a19fe0c252444fcc4f5481ca35bfc58` |
| Runner binary SHA-256 | `0587d96c6eab03727285eb231dfa373d4345076c9ca2595ad72f4f162ec9aee7` |
| Build receipt SHA-256 | `721dbd79dda742bfff7b2f4e87151a4b33a669a233e333e4c7cdac77353db0d0` |
| Results report SHA-256 | `92286e2d26e28063b84ef2876da82aa97f5877ecbbc6e1ed004f8ce0ad59f2e3` |
| Case result | `8/8` cases, `114/114` exact assertions |
| Identity mismatch result | artifact hash and SDK source hash rejected with zero runner spawns and zero host calls |
| Node | `v22.22.2` |
| Cargo | `1.97.1 (c980f4866 2026-06-30)` |
| Rustc | `1.97.1 (8bab26f4f 2026-07-14)` |

## SDK support boundary

- `Operator::execute` has the actual signature
  `fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String>`.
- `Registry::register` resolves Operators by name and version during
  `compile`.
- `parse_graph_json`, `compile`, and `Runtime::run` are the exercised public
  path. `ExecutionResult.outputs` is a `HashMap<ArcId, ArcValue>`; `journal` is
  serializable evidence.
- `Cancellation::default()` is accepted by `Runtime::run`.
- `ValueType::Object` only checks that the JSON value is an object. It has no
  field or Record schema. `ArrayOf` only checks item shape. Field-level
  validation must be explicit at the Operator/host typed boundary.
- Compile rejects an unregistered Operator and an Operator effect missing from
  the capability set. Both rejections happen before Runtime and therefore
  before any host callback.
- An Operator `Err(String)` becomes a Runtime failure with `ErrorKind::Operator`
  and no normal output ARC. Host error and EOF do not become false success.
- This SDK version requires an audited SESE graph with exactly one input ARC and
  one output ARC.

## Packaging and cleanup boundary

This proves a portable SDK resolution entry for this probe, not a portable
product artifact. The runner is a local cargo binary and is deliberately not
presented as a packaged installation. For product packaging, the same
build-time binding must be extended to the product artifact and installation
entry; that is outside this probe.

The normal cleanup target is `docs/evidence/d2-sdk-probe-20261003/.build/current`.
The first probe draft also created the worktree root `target/d2-sdk-probe`;
after preserving failed-build evidence, that subtree is removed with a
targeted `cargo clean`. Cleanup must not touch GitHub Actions, VS Code,
Codex, or any other target subtree. Checked-in source, the lockfile, receipt,
report, and input fixtures are retained.

```sh
cargo clean \
  --manifest-path docs/evidence/d2-sdk-probe-20261003/.build/current/Cargo.toml \
  --target-dir target/d2-sdk-probe
cargo clean \
  --manifest-path docs/evidence/d2-sdk-probe-20261003/.build/current/Cargo.toml \
  --target-dir docs/evidence/d2-sdk-probe-20261003/.build/current/target
unlink docs/evidence/d2-sdk-probe-20261003/.build/current/Cargo.lock
unlink docs/evidence/d2-sdk-probe-20261003/.build/current/Cargo.toml
unlink docs/evidence/d2-sdk-probe-20261003/.build/current/src/bin/probe.rs
rmdir docs/evidence/d2-sdk-probe-20261003/.build/current/src/bin
rmdir docs/evidence/d2-sdk-probe-20261003/.build/current/src
rmdir docs/evidence/d2-sdk-probe-20261003/.build/current
rmdir docs/evidence/d2-sdk-probe-20261003/.build
test ! -e target/d2-sdk-probe
test ! -e docs/evidence/d2-sdk-probe-20261003/.build
```

## Explicit non-claims

- This probe does not prove the Teams Work behavior chain or a product
  black-box path.
- It does not validate Teams Work payload schemas, permissions, transport,
  provider admission, lifecycle installation, daemon restart, OTA, or mobile
  behavior.
- It does not add a second scheduler, daemon, resource ledger, or TS SDK.
