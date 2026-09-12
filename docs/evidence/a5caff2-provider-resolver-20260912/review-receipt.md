# Exact review receipt: a5caff2

- Issue: `a5caff2`
- Base commit: `49ec07006397d191a39a5d1b5a38ccec9732317a`
- Candidate commit: `4a92c035030145f2ec0db3caeedcb3f72882cb76`
- Candidate tree: `c7a78f3d9b887a9fa0d958b3dc4fce50a1d74a93` (before integration)
- Exact changed path: `runtime/agent-process.spec.ts`
- Reviewer: independent Codex reviewer `a5caff2-exact-fixture-review-20260912`
- Decision: PASS

The typed resolver contract carries a raw bearer value. The HTTP catalog client owns the
`Authorization: Bearer <value>` projection. The previous fixture supplied the scheme twice;
the one-line correction supplies `provider-catalog` and preserves the real catalog assertion.

Validation:

- `pnpm exec vitest run runtime/agent-process.spec.ts -t 'executes remote Work in an actual Agent process, rejects duplicate ownership and restarts from durable state' --reporter=verbose`: 1 passed, 5 skipped.
- `git diff --check`: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `appsdk compile`: passed.
- `appsdk verify`: passed.

No product fallback, payload change, credential projection, or unrelated path change was introduced.
