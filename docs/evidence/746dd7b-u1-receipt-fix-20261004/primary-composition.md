# U1 current composition and artifact binding

Issue: 746dd7b. Base: dd4ffa9075b1fbc215e99070147865b4fa1495bb.

The 61 changed paths from the verified repair candidate are byte-identical in
this composition. Latest main Guidance and memory changes remain present.
Canonical AppSDK compile and verify were executed again successfully on this
base. The compiled package still contains the exact same 169 files and content
SHA256 as the real npm-pack, isolated install and installed CLI lifecycle
replay. Unchanged focused tests, typecheck, builds and that actual runtime
evidence are reused; this is not a claim of a new installed replay.

The official SDK artifact binds 23 declared file inputs, including
`generated/modules/teams-source/package-receipt.json`. That aggregate receipt
enumerates and hashes every shipped file. Primary recomputed the complete
filename-NUL-content-NUL digest and checked the complete file list, all 23
SDK input hashes, and equality with the previous package and installed-content
receipt. See `composition-and-artifact-binding.json` for identities. Aggregate
metadata stays outside `lib` to avoid a self-hashing package. SDK artifact hash,
package content digest and compressed tarball digest have distinct domains;
their numerical equality is neither required nor claimed.

The previous independent task `u1-receipt-fix-20261004-r2` terminated with
`protocol_failure`: an extra `resources_note` field violated the output schema.
Its raw output and controller result are preserved externally. It did not
produce a valid PASS. This composition is submitted to a fresh independent
review linked to that attempt, with the staged tree recorded in the primary
receipt outside the candidate to avoid a self-referential tree identity.

The package remains `mode=base`, `release_eligible=false`. These checks prove
the U1 packaging and receipt unit only. Final same-package BB01–BB14, service
adapters, persistent SDK Work and the milestone remain separate open gates.
