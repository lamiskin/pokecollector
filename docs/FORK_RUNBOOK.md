# Fork maintenance and Dev/Prod runbook

Policy: [branch naming and destinations](FORK_WORKFLOW.md).
Agent guardrails: [AGENTS.md](../AGENTS.md).

## Status and prerequisites

This is a target-state runbook, not evidence of a deployed two-instance setup.
Complete the initial migration before using the routine commands. Examples use
Git and POSIX shell syntax; substitute reviewed branch names. Run commands in
the indicated branch's clean worktree, not blindly in the shared main checkout.
Do not commit, push, open PRs, rebuild shared branches or deploy without the
authorization required for that operation.

Before changing anything:

```sh
git status --short --branch
git diff --cached
git remote -v
git worktree list
git fetch origin
git fetch upstream
```

Inspect dirty/untracked files; never stash, reset or clean someone else's work.
Use a dedicated worktree for each writing lane. If a branch is already checked
out elsewhere, use that worktree only if it is yours and clean; otherwise stop
and coordinate. Confirm `origin` is our fork and `upstream` is the source repo.

## 1. Initial migration (completed 2026-11-03)

This section is retained as the record of what was done; repeat any step only
for a new host or instance.

1. Inventory local and remote branches, open/merged upstream PRs, worktrees and
   running/stopped deployments. Locate the actual database and all photo/media
   storage on each host. Do not assume an old deployment shares this host.
2. Record and preserve `testing`/`prod` and all feature tips before any resets,
   renames or deletions. Preserve uncommitted work separately without committing
   secrets. Take and restore-test a consistent database/media backup before
   changing an existing deployment.
3. Refresh upstream and choose an upstream base. Compare code and upstream PRs,
   including squash merges. Decide which personal changes belong in stable and
   which candidates remain experimental. Avoid blindly merging old `testing`.
4. Create `fork/main` from the approved upstream base in a clean worktree. Port
   each retained difference on a `personal/*` branch and validate it. Existing
   upstream-bound work must be checked for already-merged equivalents and clean
   PR ancestry before reuse.
5. Merge accepted work into `fork/main`; create `dev` from it and add only the
   selected experiments. Publish branches only with approval. Preserve old
   branches until the migrated features, data and release have been verified.
6. Implement and validate isolated deployment configuration; establish the
   release-image build/publish process. This documentation does not create it.

## 2. Refresh the upstream mirror

After fetching, in the clean worktree that owns `main`:

```sh
git switch main
git merge --ff-only upstream/main
git push origin main
```

The push requires approval. If fast-forward fails, investigate divergence;
do not force `main` to match upstream or discard local commits automatically.

## 3. Start work and test it

From the repo, create **one** appropriate worktree (examples are alternatives):

```sh
# Upstream contribution: clean ancestry, no fork-only patches.
git worktree add -b feature/scanner-rotation ../pokecollector-scanner-rotation main
# Personal change: allowed to depend on accepted fork features.
git worktree add -b personal/retain-scan-photos ../pokecollector-retain-photos fork/main
```

Implement and commit scoped changes on the owning branch. Run focused checks
there; use current package scripts, backend test configuration and CI as the
authority for commands. Never use a live Prod container as a test runner.

In the clean `dev` worktree, merge a chosen committed candidate:

```sh
git switch dev
git merge --no-ff feature/scanner-rotation
```

Update `docs/DEV_INTEGRATION.md` on `dev` with its `fork/main` base SHA and each
candidate's name, exact SHA, destination, reason and integration-resolution
notes. Record the resulting Dev commit in the deployment record. This manifest
is created during migration, not prefilled with guessed active branches.
Deploy Dev using its isolated configuration, run checks and exercise affected
behaviour. Put actual fixes on source branches and re-integrate them; do not
leave valuable implementation work only on disposable `dev`.

To remove experiments, first preserve the current Dev tip and verify every
change exists on a durable source branch. Build a temporary integration branch
from `fork/main`, merge the manifest's selected SHAs and verify it. Move `dev`
only after checking worktree ownership and coordinating users. Updating remote
`dev` may require an approved `--force-with-lease`; never force-push stable
branches. Do not copy an old manifest without reconciling its entries.

## 4. Submit upstream and/or accept into the fork

For an upstream-bound branch, review the **complete** PR diff for personal
patches, secrets, unrelated changes and sensitive data:

```sh
git log --oneline main..feature/scanner-rotation
git diff main...feature/scanner-rotation
# Only when the user authorizes publishing and opening the PR:
git push -u origin feature/scanner-rotation
gh pr create --repo Git-Romer/pokecollector --base main --head lamiskin:feature/scanner-rotation
```

Use the existing upstream PR template and report validation. Never submit
`personal/*`, `sync/*`, `release/*`, `dev` or `fork/main` upstream.

For acceptance into the fork, in the clean stable worktree, merge only an
approved source branch (personal or upstream-bound), not all of Dev:

```sh
git switch fork/main
git merge --no-ff personal/retain-scan-photos
```

Reconcile and verify the stable combination; Dev testing of a different
combination is not proof this one works. Push `fork/main` only after the required
gates and approval. Record personal behaviour in `docs/PERSONAL_PATCHES.md`:
purpose, owning branch/source commits, touched areas, tests, upstream overlap
and intentional differences. Create that register during migration.

## 5. Integrate upstream into the stable fork

First refresh `main` (step 2), then:

```sh
git worktree add -b sync/upstream-2026-11-03 ../pokecollector-upstream-sync fork/main
cd ../pokecollector-upstream-sync
git merge --no-ff main
```

Record the upstream SHA. Resolve conflicts and inspect semantic overlap,
especially our PRs accepted upstream by squash. Preserve intended personal
behaviour; retire redundant patches deliberately. Run focused checks while
iterating, then the repository-required integration gates after reconciliation.
Test this sync candidate in isolated Dev, including migrations and retained
features. After acceptance, merge the sync branch into `fork/main` and rebuild
Dev's selected integration when appropriate. Never merge Dev to achieve this.

## 6. Build and validate a release

1. Select ready work into `fork/main`, then cut a release branch, for example
   `git worktree add -b release/1.55.1-fork.1 ../pokecollector-release fork/main`.
   No experimental branch merges after selection.
2. Commit release fixes on the release branch, merge them back into `fork/main`,
   and freeze an exact release SHA reachable from `fork/main`. No tag until the
   final candidate is tested; a subsequent change invalidates affected evidence.
3. Build our frontend/backend images once from that SHA, with source labels.
   Pin sidecar images too. Use a registry/delivery mechanism chosen during
   deployment implementation. Do not substitute upstream's prebuilt app images.
4. Record upstream base SHA, fork SHA, full image references and digests, build
   platforms, configuration version (not secrets), migration version and test
   evidence in an immutable release manifest. Keep host-specific/secrets-bearing
   deployment records outside public Git. Ensure architectures are supported.
5. Temporarily run the **clean release candidate** in Dev, not Dev's extra
   experimental combination. Use the same digests intended for Prod. Exercise
   migrations on an approved copy of representative data and smoke-test the app.
6. After acceptance, create an annotated tag such as `fork-v1.55.1-1` pointing
   at the tested SHA and push that explicit tag with authorization. Never move
   an existing release tag. A failed candidate gets fixes and renewed testing.

Minimum release checks: current required backend/frontend tests and build/CI
checks, rendered Compose validation, startup/readiness and API checks, then
collection edits, owned photos, scanner/review, pricing and currency, search,
binders and any adopted decks/Pokédex features. Test mobile viewport behaviour
on a real phone. Confirm the retained personal-patch register is covered.

## 7. Deploy two isolated instances

Before first deployment, implement an environment-specific Compose setup with:

- Project names `pokecollector-dev` and `pokecollector-prod`.
- Separate deployment directories and env files; distinct ports/hostnames.
- No shared hard-coded container names, databases or writable host mounts.
- Separate auth, own photos, images, scan files, backups and secrets. Inventory
  actual current storage rather than assuming this list covers new upstream.
- Independent networks/volumes and explicit resource limits as needed.
- Dev notifications disabled, approved scanner credentials and internal access.
- No unauthenticated public exposure; `PUBLIC_MODE=false` is not access control.

The existing root Compose file is **not yet dual-instance-safe**. Project names
do not fix its `container_name` collisions or shared relative bind paths.
Validate the rendered configuration and actual mounted paths for both instances
before startup. Keep credentials out of Git and diagnostic output.

For each Prod upgrade: authorize the maintenance window, take a consistent
database/media backup, verify recovery evidence, record the previous digests,
then deploy the approved manifest without rebuilding images on the server.
Check logs, readiness, collection/photo integrity and important workflows.
Return Dev to its experimental integration afterward if desired. Exact host,
Compose commands, backup locations, health checks and artifact delivery must
be added after inspecting the real deployment; none are invented here.

## 8. Rollback and cleanup

Image-only rollback is safe only when the older app supports the current
schema/data. Otherwise restore a **matched** database/media backup and compatible
release, with approval for the outage and loss of writes since that backup.
Rehearse recovery in isolation before relying on it. Never delete volumes as
deployment cleanup or automatically copy Dev data over Prod.

After successful integration and resolution of any upstream PR, verify source
changes are retained before deleting branches/worktrees. Squash merges require
code/PR verification, not just `git branch --merged`. Keep release tags,
manifests and backups according to the chosen retention policy. Do not delete
historical `testing`/`prod` until migration is verified and deletion is approved.
