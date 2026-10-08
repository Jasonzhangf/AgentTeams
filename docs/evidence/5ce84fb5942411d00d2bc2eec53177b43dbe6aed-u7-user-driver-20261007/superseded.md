# Superseded evidence directory

Status: `SUPERSEDED 2026-10-07 (U7 round 11)`

This directory records the U7 driver run against candidate
`1ac7b920c62cd6c27637165b1dbac38d47818385` (tree `5ce84fb5942411d00d2bc2eec53177b43dbe6aed`),
based on merged U6 `main` `25bcd8cab11d24e5b31371923ed5111caed6e8e8`.

## Why it is superseded

| Fact | Value |
|---|---|
| Recorded result | 13 of 14 cases passed; `BB13` did not pass |
| BB13 blocker at that time | `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0010:required_binary=appsdk-0.1.0010` — the installed `appsdk` was 0.1.0011 while `.appsdk/project.json` pinned 0.1.0010 |
| Follow-up | the pin was promoted to 0.1.0011 and then to 0.1.0012 (both promotions explicitly authorised by the human), and the candidate was re-run |
| Current evidence | `docs/evidence/07b4a73eceb1b90e448433c626c2fe233c17a4bc-u7-user-driver-20261007/` — 14 of 14 passed on candidate `50bf7aa1788294943ad032809bf2fed14e213e3c` |

## What is preserved

Everything in this directory is preserved verbatim, including
`u7-user-driver.receipt.json`, `run.log`, `validation.md`, `appsdk-pin-mismatch-on-base.log` and
`cases/BB01…BB14/`. No historical result, exit code, timestamp or status in this directory has been
rewritten.

`validation.md` carries a dated notice at the top pointing at the current directory. That notice is
the only change made to this directory.

## What this means for acceptance

This directory must not be used as the current U7 acceptance evidence. The current acceptance
evidence is the round-11 directory named above; the earlier 13/14 result stands as history and is
not retroactively changed to 14/14.
