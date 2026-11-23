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
| `fork-v1.57.9-2` | `b20e005` | `56cc1bb` (1.57.9) | `sha256:a2ff83d502c3ee05b9c197dfb434d33932b8ec734dfcbe392b5eedf441dc42a9` | `sha256:ebfed8986b86b03dc5b7c813fa27bffcc75fee5d755559be8d7797ea774ec364` | 2026-11-21 |
| `fork-v1.57.9-3` | `f5e7608` | `56cc1bb` (1.57.9) | `sha256:a3bc05da75e69c7e3786fbd1407ce48c2a5756b3c8affee6df8fb8d75911dd37` | `sha256:3137e814afbeea1044d6c10e44a5a542c4e721f155f9dca56d04b8ab134b0a8d` | 2026-11-21 |
| `fork-v1.57.9-4` | `f8b0fef` | `56cc1bb` (1.57.9) | `sha256:4af20b41bfc14a568cb54f85c39e3d8b33dd887b430a6fa098ce6d896e81ca64` | `sha256:0da5057abab4635182514973877161916c27eded70874e9f4fd0090c2a1c75e3` | 2026-11-21 |
| `fork-v1.57.9-5` | `78fe61e` | `56cc1bb` (1.57.9) | `sha256:332ac5d8a9f3aff651b44264e36d0ec4a080f42494a7c6ad1a85281914dead83` | `sha256:e81a344e696d6847c7a32d89acc77034fd92de9a76c3e39a3964b1bf5083b39c` | 2026-11-21 |
| `fork-v1.57.9-6` | `cd436c7` | `56cc1bb` (1.57.9) | `sha256:9782b938799f5745a4aeb1ad8d6f7f53674ba8d317fde7f54499031d59c29095` | `sha256:164336dc9db860de1115233790511078a6ce4893316bdfe2683092887bcfcdb1` | 2026-11-22 |
| `fork-v1.57.9-7` | `3415243` | `56cc1bb` (1.57.9) | `sha256:bc2f0aa0304502fe69f5b78fab717c0167d8c131fdfb621f7d54f1be586e0246` | `sha256:b62253e24f39a27558f9790e75c55a5e8630903686fbc12d924fe6f2bdc72e0b` | 2026-11-22 |
| `fork-v1.57.9-8` | `45d99b6` | `56cc1bb` (1.57.9) | `sha256:2b7dfe716f94f39d7697aee92cb6791bf2aa3dfaeb1b64295a3261f0d821ad5b` | `sha256:adca34f67b92095b11fb6af7b30542c5f54d9ae41810dbc20418823e28b4f4bf` | 2026-11-22 |
| `fork-v1.57.9-9` | `13896fb` | `56cc1bb` (1.57.9) | `sha256:be7ba02fe1b9162cad4f477a8cb9a62ded69ede7f1eccc84e5492a78e3c2f2f2` | `sha256:943ca20932ad19436778b21ace56218554886ca9673c22512deace9c43f264a2` | 2026-11-23 |
| `fork-v1.57.9-10` | `c60997e` | `56cc1bb` (1.57.9) | `sha256:9ea3aa8e8c4353b47ee17a42e5e0d545f6789419cf027521093c5efd870654fc` | `sha256:f1efea36eb609ebe607739fdc1817d1216a7624eec6a33bca4e4db7ab9a19400` | 2026-11-23 |
| `fork-v1.57.9-11` | `9aef25e` | `56cc1bb` (1.57.9) | `sha256:d5261423d6535fe09a75a7e332c7da65b3a01db108bef52a57d6196d1601afde` | `sha256:235f6628ba4ae8498336ed600ff016c49df3ba1c8ac243447c8c7e5e163f5092` | 2026-11-23 |

`fork-v1.55.1-1` is deliberately absent: it is a local annotated tag on
`2f3c2b8` (the OIDC release candidate) and names the local images Prod ran
before the first published release. It was never pushed and predates the release
workflow.

## Adding a release

Before running either a dry run or a publish, commit
`docs/release-notes/<exact-fork-tag>.md` with highlights verified against the
tagged tree. The workflow enforces two checks before it builds anything:

- **Coverage.** Every PR merged since the previous release that changed
  application code must be named in the highlights file, otherwise the run fails
  and lists what is missing. Docs-only and test-only PRs are exempt. Name PRs in
  a hidden marker so the visible notes stay readable, for example
  `<!-- release-coverage: #10 #11 #12 -->`; the marker may sit anywhere in the
  file, and a plain mention such as `#12` also satisfies the check.
- **Register.** The previously published release must already have its row in
  this file; a release cannot be cut while the last one is unrecorded.

Start from [`release-notes/TEMPLATE.md`](release-notes/TEMPLATE.md);
do not treat ancestry as evidence that a feature shipped. The workflow fails if
the exact-tag file is missing or empty. Review the generated GitHub notes and
manifest in the dry-run artifact, including the point-in-time `origin/main`
mirror tip and lag, before publishing. After publication, add a row here on
`fork/main` from the manifest. Record only public tags, commit SHAs, digests and
dates; environment-specific detail belongs in the operator's private record.

Release highlights must include screenshots for user-visible visual changes
when an image materially clarifies the change; they are expected for visual
features and substantial UI changes. Omit them for internal/non-visual changes,
when the prose is already clear, or when a safe screenshot cannot reasonably be
made; briefly explain an omission for a visual change. Commit the images under
`docs/release-notes/assets/<exact-fork-tag>/` before tagging and reference them
inline by absolute, tag-pinned URL, for example
`https://raw.githubusercontent.com/lamiskin/pokecollector/<exact-fork-tag>/docs/release-notes/assets/<exact-fork-tag>/<file>.png`;
the release body is generated from the committed highlights file, so relative
paths do not resolve. A screenshot added to an already-published release cannot
use a tag-pinned path, because the tag tree is immutable: attach it to that
release instead and link
`https://github.com/lamiskin/pokecollector/releases/download/<exact-fork-tag>/<file>`.
Crop to the changed UI, keep each file small (roughly 1200 px wide, a few
hundred KB) and give every image alt text. Use demo data only: the repository
and the published notes are public, so a screenshot must not show a real
collection, personal names or email addresses, OIDC identities, API keys,
private hostnames or addresses, or browser chrome containing a URL.
