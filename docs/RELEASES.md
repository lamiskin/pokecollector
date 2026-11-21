# Fork release register

One row per published `fork-v*` release. The GitHub release notes are the
user-facing summary: curated highlights plus generated upstream/fork comparisons,
test results, pinned images and deployment guidance. The attached
`release-manifest.json` is the artifact provenance record (tag, fork SHA,
upstream base and mirror tip/lag, prior-release comparison, platform, digests and
test evidence). This register records what was published and where Prod came
from.

Images live under `ghcr.io/<owner>/pokecollector-{backend,frontend}` and are
pulled by digest, never rebuilt on the server.

| Tag | Fork SHA | Upstream base | Backend digest | Frontend digest | Published |
| --- | --- | --- | --- | --- | --- |
| `fork-v1.55.1-2` | `66578ed` | `5df7cea` (1.55.1) | `sha256:6078eb8c9cfe18678d28929b46e2c858937494c5fc79b2e87561a23df8f7f982` | `sha256:e66591d2b06b0f6d559946d21ebd1bbda019a45d14a38b7543d130b45a67f836` | 2026-11-04 |
| `fork-v1.55.1-3` | `0b2e576` | `5df7cea` (1.55.1) | `sha256:70a8238ea6626fd42264b36271f0286c0fe7d05bb99181fdda138ebf7d9f759e` | `sha256:85ba0d6472172e938dfae735800a0277c348ad86fd85cf03a2907ffd38cff075` | 2026-11-04 |
| `fork-v1.55.1-4` | `434e8a7` | `5df7cea` (1.55.1) | `sha256:c17d913efc5bb5744ee0ef30977e6187bbb8d8f1856e460203d357f1513f2982` | `sha256:0f562a20ce6d96a8287786637f4b57a91de297b23b4c4514bb5d0fb9ff724559` | 2026-11-04 |
| `fork-v1.57.9-1` | `72d5824` | `56cc1bb` (1.57.9) | `sha256:9ffc63c79145e70a71c6c5792c124f4ac979d015651da3fe321c4d35e82c7b1f` | `sha256:cfed8287399d526c7cb15f81a3f782960839ab0e50e881844733fd8be80fa002` | 2026-11-21 |

`fork-v1.55.1-1` is deliberately absent: it is a local annotated tag on
`2f3c2b8` (the OIDC release candidate) and names the local images Prod ran
before the first published release. It was never pushed and predates the release
workflow.

## Adding a release

Before running either a dry run or a publish, commit
`docs/release-notes/<exact-fork-tag>.md` with highlights verified against the
tagged tree. Start from [`release-notes/TEMPLATE.md`](release-notes/TEMPLATE.md);
do not treat ancestry as evidence that a feature shipped. The workflow fails if
the exact-tag file is missing or empty. Review the generated GitHub notes and
manifest in the dry-run artifact, including the point-in-time `origin/main`
mirror tip and lag, before publishing. After publication, add a row here on
`fork/main` from the manifest. Record only public tags, commit SHAs, digests and
dates; environment-specific detail belongs in the operator's private record.
