# Fork release register

One row per published `fork-v*` release. The authoritative per-release detail is
that release's `release-manifest.json` asset (tag, fork SHA, upstream base,
platform, digests, test evidence); this register exists so the repository itself
records what was published and where Prod came from.

Images live under `ghcr.io/<owner>/pokecollector-{backend,frontend}` and are
pulled by digest, never rebuilt on the server.

| Tag | Fork SHA | Upstream base | Backend digest | Frontend digest | Published |
| --- | --- | --- | --- | --- | --- |
| `fork-v1.55.1-2` | `66578ed` | `5df7cea` (1.55.1) | `sha256:6078eb8c9cfe18678d28929b46e2c858937494c5fc79b2e87561a23df8f7f982` | `sha256:e66591d2b06b0f6d559946d21ebd1bbda019a45d14a38b7543d130b45a67f836` | 2026-11-04 |
| `fork-v1.55.1-3` | `0b2e576` | `5df7cea` (1.55.1) | `sha256:70a8238ea6626fd42264b36271f0286c0fe7d05bb99181fdda138ebf7d9f759e` | `sha256:85ba0d6472172e938dfae735800a0277c348ad86fd85cf03a2907ffd38cff075` | 2026-11-04 |
| `fork-v1.55.1-4` | `434e8a7` | `5df7cea` (1.55.1) | `sha256:c17d913efc5bb5744ee0ef30977e6187bbb8d8f1856e460203d357f1513f2982` | `sha256:0f562a20ce6d96a8287786637f4b57a91de297b23b4c4514bb5d0fb9ff724559` | 2026-11-04 |

`fork-v1.55.1-1` is deliberately absent: it is a local annotated tag on
`2f3c2b8` (the OIDC release candidate) and names the local images Prod ran
before the first published release. It was never pushed and predates the release
workflow.

## Adding a release

After the workflow publishes, add a row here on `fork/main` with the values from
that release's manifest. Record only what is public: tags, commit SHAs, digests
and dates. Host names, credentials, backup paths and other environment-specific
detail belong in the operator's private deployment record, not this file.
