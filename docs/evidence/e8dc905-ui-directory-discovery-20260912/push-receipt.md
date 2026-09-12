# e8dc905 push receipt

- Product integration commit pushed first: `07baf9ac8454b458f971eaf0c95060c903cf686f`.
- Evidence receipt commit: `9bfc36a451511ed1a792a294809ab6fb1d94ebc4`.
- Push command: `git push origin HEAD:main`.
- Remote verification after the evidence receipt push: `git ls-remote origin refs/heads/main` returned `9bfc36a451511ed1a792a294809ab6fb1d94ebc4`.

The product source commit was pushed before the receipt-only evidence commit. No force push, hook bypass, or unrelated branch update was used.
