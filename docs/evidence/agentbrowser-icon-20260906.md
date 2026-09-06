# AgentBrowser icon admission and desktop fixture evidence

Date: 2026-09-06. Candidate: `0e1356c` plus this evidence record.

The user supplied `minimal_cloud_browser_1788618910206.jpg`. The project keeps
the unchanged JPEG at `ui/teams-console/assets/agentbrowser-icon.jpg` with
SHA-256 `e310c0ee9f7ebb9da88f68498a90e6cd83f4540541574251c90da5e83e736587`.

The UI binds this asset only when an Agent projection declares the `browser`
capability. The compiled browser fixture was served from the built
`ui/teams-console/lib` directory. A real desktop browser load showed an
accessibility image node with alt text `AgentBrowser icon` beside the
`AgentBrowser` card, whose capability text was `Capabilities: browser`.

`pnpm build:governance` followed by `pnpm smoke` passed. Packaged artifact
smoke compared the source JPEG byte-for-byte with
`generated/modules/teams-source/lib/ui/assets/agentbrowser-icon.jpg`.

This evidence proves project admission, compiled packaging, and desktop fixture
rendering. It does not prove a production host integration, a physical phone,
or platform-specific resized icons.
