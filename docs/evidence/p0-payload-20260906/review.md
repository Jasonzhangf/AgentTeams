# P0 business JSON boundary evidence

Base: `dba3dd6230c2c5e83a8b5d1f8e8fc99235e24609`.
Owner: primary / control-protocol. Scope: protocol JSON preservation, declared
envelope validation, affected maps, regression threshold and compiled HTTP smoke.

Before intervention, new focused tests produced 16 failures and 9 passes
(`red.log`). The first divergence was the recursive business-key blacklist and
object-only recursion; unrelated extra envelope fields were accepted.
The replacement validates JSON values without coercion and admits only declared
outer fields. Payload properties never supply transport state.

After intervention, `pnpm verify` exited 0: 33 files / 142 tests, typechecks,
real library builds, Guidance/AppSDK compile, compiled HTTP smoke and AppSDK verify
(`validation.log`). The HTTP replay uses the built Console and proves that legal
arrays/control-like business names pass protocol validation and reach missing
relation admission; misplaced message control fails earlier. It deliberately
does not execute a provider or prove remote work.

Primary review on 2026-09-06: PASS for this scope. Removing the two blacklists
avoids two owners for arbitrary business-key policy. One JSON validator serves
Agent messages, Session body/metadata/delta. Typed envelope allowlists explicitly
reject unsupported placement; they do not infer or rebuild auth/route truth.
Tests cover non-JSON values, cycles, shared objects, lossy properties, unknown
frame kinds and missing generation. Existing channel generation tests remain.

This record is AI-reviewed and human-unreviewed. Source merge and full P0 are
not yet complete: explicit Session selection remains; daemon/direct/relay work,
provider replay and desktop/mobile acceptance are separate later evidence.
Smoke servers close in finally. The owner worktree is retained for review and
commit; it must not be described as cleaned until evidence is archived and
the worktree is safely removed.
