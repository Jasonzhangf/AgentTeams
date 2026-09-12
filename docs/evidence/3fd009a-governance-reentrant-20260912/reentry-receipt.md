# Reentry receipt: 3fd009a

- baseline clean candidate: `b8bd9490b5097fd79818913365a359f4b1003194`; `pnpm lifecycle:admission` passed with verify, installed smoke, Relay/Agent restart and signal shutdown
- reentry candidate: `5ffbd0725391a6776e68c057278dd5722b2d916c`; first `pnpm lifecycle:admission` passed with the same gates
- interrupted recovery simulation: removed the first validation record while retaining stage state and receipts
- second admission: passed in about 1.1s; `pnpm-verify` and `pnpm-smoke-installed` both reported `status=reused`
- reuse receipts: `2`
- invalidation history: `0`
- artifact hash: `sha256:1a5e486651e4c3ae449795497dc5650a54439fa2a5b4589dfb61f00c2f4a1c31`
- final integration checks: `node --check scripts/lifecycle-adapter.mjs`; `git diff --check`; `appsdk verify`; `appsdk compile`
- result: pass
