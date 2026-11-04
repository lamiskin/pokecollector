# Fork branches and release policy

Agreed workflow, 2026-11-03. This describes the target model; it does not mean
the existing `testing`/`prod` branches or deployments have been migrated.
Operational procedures: [fork runbook](FORK_RUNBOOK.md).

## Principles

- Track upstream without losing permanent personal features.
- Test upstream contributions alongside our extras without including those extras
  in the upstream PR.
- Separate experimental Dev integration from stable Prod releases.
- Name a working branch by its destination, not its testing stage. Keep its name
  throughout implementation, Dev testing and review.
- Preserve stable history. Rebuilding Dev must never discard the only copy of work.

## Permanent branches

| Branch | Contents | Deployment / destination |
| --- | --- | --- |
| `main` | Fast-forward-only mirror of `upstream/main`; no fork commits | Base for upstream contributions |
| `fork/main` | Accepted upstream changes plus accepted personal and upstream-bound work | Source of stable fork releases |
| `dev` | `fork/main` plus explicitly selected candidate branches | Dev instance only; disposable integration history |

Remotes: `origin` is `lamiskin/pokecollector`; `upstream` is
`Git-Romer/pokecollector`. Push working branches to `origin`, not `upstream`.
`main` mirrors the latest fetched upstream; `fork/main` adopts updates only after
integration testing. Neither permanent stable branch is routinely force-pushed.

## Working prefixes

| Prefix | Start from | Destination | Example |
| --- | --- | --- | --- |
| `feature/*` | `main` | Upstream feature PR; optionally accepted into `fork/main` first | `feature/scanner-rotation` |
| `fix/*` | `main` | Upstream bug-fix PR; optionally accepted into `fork/main` first | `fix/scan-upload-timeout` |
| `docs/*` | `main` | Upstream documentation PR | `docs/scanner-setup` |
| `chore/*` | `main` | Upstream maintenance PR | `chore/update-test-tooling` |
| `personal/*` | `fork/main` | Our fork only; never an upstream PR | `personal/japanese-pricing` |
| `sync/*` | `fork/main` | Integrate a chosen upstream commit into `fork/main` | `sync/upstream-2026-11-03` |
| `release/*` | `fork/main` | Isolated release preparation and Dev validation | `release/1.55.1-fork.1` |

Use lowercase kebab-case after the prefix, describing one outcome. Add an issue
number only if useful, for example `fix/419-gallery-number-matching`. Avoid agent
names, random suffixes, `fresh`, `v2`, and stage prefixes such as `testing/*` for
new work. Existing names may remain until migration is deliberately performed.

`personal/*` covers **all** fork-only changes: features, fixes, docs and deployment
configuration. Do not use `private/*`: code pushed to a public fork is public,
regardless of its branch name. Never commit secrets or unapproved personal data.
If one request includes personal and upstream-worthy work, split the changes.
Upstream branches must not depend on `fork/main` or merge `dev`/personal patches.

## Stages and destinations

1. **Implement:** one scoped working branch, with focused tests.
2. **Integrate in Dev:** merge selected source branches into `dev`; record each
   branch, exact commit and purpose. Resolve integration-only conflicts there,
   but put real fixes back on their owning branch.
3. **Accept for the fork:** merge only ready source branches into `fork/main`.
   Never merge the whole `dev` branch. Acceptance into the fork is independent
   of upstream accepting an upstream-bound PR.
4. **Prepare a release:** branch `release/<upstream-version>-fork.<n>` from the
   stable fork, without adding experiments. Return release fixes to `fork/main`
   before freezing the final release commit.
5. **Build and validate:** push the immutable annotated tag; the Fork Release
   workflow builds our images from that exact commit, publishes them, and
   writes the release manifest. Deploy the clean release candidate to Dev by
   digest, then the same digests to Prod after approval and a verified backup.

Prod uses immutable annotated tags, for example `fork-v1.55.1-1`. The upstream
version is a reference point, not a claim that the fork equals upstream. Record
the exact upstream base SHA, fork SHA, image digests, platform and migration
details in a release manifest. Rebuilds with different digests are different
artifacts and require validation. Do not deploy stock upstream images in place
of fork images: they do not contain our extras.

Fork images are built and published by `.github/workflows/fork-release.yml` to
`ghcr.io/<owner>/pokecollector-{backend,frontend}`, tagged with the release tag
and pinned by digest. Upstream's `.github/workflows/release.yml` is inherited
verbatim: it targets Git-Romer's namespace, reuses upstream images, and is not
the fork's release pipeline. Do not push fork commits through it.

When upstream squash-merges our PR, its SHA differs from our original commits.
Reconcile overlapping code on the next `sync/*` branch; do not infer missing
features from ancestry counts or blindly re-merge already-shipped patches.
Delete a source branch only once its changes are safely retained and any PR is
resolved; keep release tags and stable history.

## Dev and Prod

Both instances run locally from this checkout. Fork images are published to
GHCR by the release workflow and pinned by digest in `.env.prod`; a local build
remains a fallback, but it is a different artifact and needs its own evidence.
Moving Prod to another host requires a database and media copy plus the
release's pinned digests.

- Separate Compose projects, deployment directories, configuration, networks,
  databases, secrets, auth files, photos, uploads, caches and backups.
- Prod owns real collection data. Dev uses synthetic data or an approved,
  one-way backup copy, never a live Prod database or writable media directory.
- Disable Dev notifications and other external side effects; deliberately
  configure scanner credentials and quota use. Never automatically sync Dev
  collection edits back to Prod.
- Dev is internal. `PUBLIC_MODE=false` is not authentication or network access
  control; do not expose single-user/no-login instances publicly.
- The current Compose file has hard-coded `pokemon-*` container names and
  relative bind mounts. Different project names alone do not isolate two stacks.

## Migration from the old model

The old `testing` branch is historical integration evidence, not the automatic
base for the new stable fork. The old reset-based `prod` workflow is retired by
this policy, but existing branches/data stay untouched until migration.

Preserve old tips, inventory every candidate, start the stable fork from a
chosen current upstream base, and port only the intended remaining differences.
Much scanner/UI work has already landed upstream as squashes. Review whether
upstream currency support replaces the old AUD patch. Independently classify
Japanese pricing, scan-photo retention, external lookups, mobile fixes and
unintegrated binder/search work; do not assume every old branch belongs in Prod.

Keep a small personal-patch register and a Dev integration manifest as described
in the runbook. These identify retained behaviour and reproducible inputs, not
an extra permanent overlay branch to rebuild every release.
