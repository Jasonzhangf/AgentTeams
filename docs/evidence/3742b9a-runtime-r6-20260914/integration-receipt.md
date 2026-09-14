# Integration Receipt: 3742b9a Runtime R6

- delivery unit: `3742b9a`
- candidate commit: `f664484fe73f20eb0db24eadc79de486009de66d`
- integration commit before receipt: `c5ad37f13e9f43baa8f0a78a1a5122a5c7a924a4`
- candidate tree: `ab64866158c05972c4f93924792efe1ea01706e2`
- integration tree before receipt: `ab64866158c05972c4f93924792efe1ea01706e2`
- base: `origin/main@a0d4b67a0dc45e41101a64e9ab34ccc2dbb9b08f`

The five candidate commits (`74045cc`, `534b0cc`, `b4cce4a`, `954afa4`,
`f664484`) cherry-picked cleanly into the clean integration worktree. The
candidate and integration trees are byte-identical, so the commit-bound Codex
review `20260914T043000Z-review-r6-final-commit` remains valid by tree identity.

Integration admission was rerun from the integrated tree after installing the
frozen workspace dependencies:

```text
attempt: attempt-1789358152985-a90301e0-f04c-4431-ab88-144a963e4298
candidate: c5ad37f13e9f43baa8f0a78a1a5122a5c7a924a4
artifact: sha256:edc5a828bbf0b0abced7eda52103742a4e56d59ab44ebe3754a01d6f24ece3b9
result: pnpm verify and pnpm smoke:installed passed
```

The integrated tree has no source or test delta from the reviewed candidate.
This receipt records integration evidence only; merge, remote push and cleanup
remain separate steps.
