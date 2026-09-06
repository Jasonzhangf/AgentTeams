# Independent Console process

Build with `pnpm build`, then run `node generated/runtime-lib/runtime/console-process.js --config <file>`.
The Console registers its own configured identity with relay and binds only the listed Agent IDs.
Each target daemon must authorize this identity in `policy.allowedManagers`; relay admission alone
does not grant management rights. Closing Console closes its listener and registration, leaving
Agent-owned Work execution independent.

The version 1 JSON file has these fields:

- `identity`, `scopeId`, `presenceIntervalMs`, `relay`: same runtime bootstrap declaration and
  relay settings as [Agent process](agent-process.md). Shared parser: `process-config.ts`.
- `agentIds`: unique target IDs, including passive Agents when desired.
- `listen`: `host`, `port`, exact browser `origin` (scheme, hostname, optional port), and optional
  `certFile` / `keyFile` pair. Non-loopback listeners require TLS. Port 0 is available for test
  allocation; deployed browser origin must match the actual access URL.
- `auth`: `username` and `passwordEnv`. Only the environment reference is stored in this file.
  Browser HTTP Basic authentication applies to both static resources and API. Cross-origin and
  cross-site browser requests are denied; Agent authorization remains separate.
- `staticRoot`: directory containing `console.html` and `console-entry.js`.
- `uiRoot`: built UI directory containing `browser.js` and its `client/` modules.

Relative file paths resolve from the config directory. In the packaged artifact, static files
are under `lib/static`, UI under `lib/ui`, and the process under
`lib/runtime/runtime/console-process.js`. Unknown config keys and missing credentials fail;
credentials and TLS private keys are not published in the relay declaration.

SIGINT/SIGTERM close owned connections. Startup bind failure releases relay registration.
No command is retried or declared complete because a browser connection closed.

Current evidence: local actual Node child plus HTTPS/relay, authenticated page access,
shutdown, and port-bind failure cleanup. This is not public-network or real-phone acceptance.
