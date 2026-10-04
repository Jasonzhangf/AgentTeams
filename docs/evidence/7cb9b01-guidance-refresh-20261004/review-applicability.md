# 7cb9b01 review applicability and retained limitation

The delivery unit refreshes an official generated artifact so the existing
`appsdk guide compile` step no longer changes tracked source during admission.
It does not implement a guidance CLI domain or claim communication recovery.

The first independent review returned FAIL for an unreachable
`communication-recovery` projector. The underlying limitation is real: the
canonical AppSDK binary returns structured
`GUIDANCE_DOMAIN_UNKNOWN:communication-recovery`. Upstream SDK issue `964e36c`
tracks it and remains open. This unit cannot close that issue or claim that
domain is usable. The first review's invocation of `guide init --mode` without
`--task` is not a valid domain test; the primary observed `GUIDANCE_USAGE` there.
The direct `guide communication-recovery .` invocation is the valid reproduction.

The applicable project contract has not changed:

- `.appsdk/project.json` declares `guidance.enforcement = advisory`.
- `docs/development-governance.md` states that guidance helps planning and does
  not duplicate quality PASS.
- The shared review standards treat Guidance as auxiliary; its absence alone
  is not an engineering failure. Required compilation/source integrity still
  applies and is verified here.

The unchanged declared guidance source already includes `communication-recovery`;
the stale committed artifact omitted it. The official generator refresh adds
its compiled projection; it does not add a new product dependency on the
unsupported dispatcher. Required admission
executes `guide compile` through `pnpm verify`; it does not execute the
`communication-recovery` projector. No source declaration is removed, no output
is hand-edited, no SDK downgrade or gate bypass is used.

The independent follow-up review must assess this corrected evidence boundary:
official deterministic compile, current source digests, unchanged advisory
enforcement and absence of a new runtime dependency. Any actual required-gate
or evidence-integrity defect remains blocking. This note does not rewrite the
first FAIL or convert it into a PASS; the follow-up reviews a new exact tree.

The true clean committed admission node is still deferred until review and
commit. Only that node can prove the post-stage clean guard remains clean.
Guidance compile idempotence is not full admission, reentry, installation or
MVP completion evidence. U7 late-stage evidence-binding hypothesis remains
unconfirmed and is outside this unit.
