# Reused evidence

These copies are summaries of earlier worker-run evidence. They are reused only
within the boundaries below. The original files remain under
`/Volumes/Intel/playground/agentteams/.worker-runs/`.

## Same-tree evidence

`0bb9c97fcd5a20e1a4d807234f1f0d240efabf2f` has tree
`f22bf13a2da37a4f04add2a97460794bc18fe216`, which is the same tree as
`6d7dcf9d19bba415aa566b910cc4ec472ae2bf44`. The following evidence therefore
applies to the current candidate at the tree level:

- `webui-provider-closure-corrected-0bb9c97-RESULT.md`: 32/32 checks passed.
  Real RCC endpoint `http://127.0.0.1:4444/v1`; bounded 429 retry
  (429, 429, 200) and terminal 401 with no replay. The provider instance id
  `goaichat` is a misleading label; its effective base URL is the local RCC
  endpoint on port 4444.
- `config-readonly-ui-installed-0bb9c97-RESULT.md`: 10/10 checks passed on an
  installed npm tarball. The settings drawer is read-only with 0 buttons;
  `config.putProvider`, `config.bindModel`, `config.refreshModels` and
  `config.apply` return `UNSUPPORTED_OPERATION`.

## Supporting evidence with a tree boundary

- `webui-journey-acceptance-RESULT.md`: 95/95 and 37/37 checks passed on
  `b7236b2a4dad0308e2769011d71effc0c0bad543`. It covers discovery, session
  creation, message send, permission allow/reject/always, final reply,
  restart, history load, groups unavailable render, and 390x844 tap targets.
  The product delta from `b7236b2` to `6d7dcf9` is the read-only Console
  config surface: `ui/teams-console/src/client/locale.ts`,
  `ui/teams-console/src/components/render.ts`,
  `ui/teams-console/src/state/controller.ts`, their tests, and two architecture
  maps. The same-tree `0bb9c97` installed evidence covers that changed surface.
  This is supporting evidence, not an exact-tree replay of every journey step.
- `c5e5d4f-prior-acceptance-RESULT.md`: the prior acceptance record on
  `b7236b2`. It is kept for context only. The `6d7dcf9` browser and installed
  receipts in this directory supersede its browser and installed results.

## What is not reused

- No loopback, health or mock evidence is reused as public Relay, public direct
  transport, N3/STUN/NAT or physical cellular evidence.
- The `teams-static-ui-replay` gate remains `partial`; the mobile screenshot is
  viewport evidence only.
