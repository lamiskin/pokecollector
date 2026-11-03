# PokéCollector

## Fork workflow (read first)

- Policy and naming: [docs/FORK_WORKFLOW.md](docs/FORK_WORKFLOW.md).
- Procedures: [docs/FORK_RUNBOOK.md](docs/FORK_RUNBOOK.md).
- Dev/Prod operation: [docs/FORK_DEPLOYMENT.md](docs/FORK_DEPLOYMENT.md).
- This structure is in place: `fork/main` is the stable line, `personal/*` holds
  fork-only work, and both local instances run from this checkout. Legacy
  `testing`/`prod` and the old `pokemon-*` containers are pre-migration
  evidence: do not reset, rename, delete or migrate them implicitly.
- Before work: inspect status, staged changes, remotes and worktree ownership.
  Preserve unrelated/untracked files; use isolated worktrees for parallel work.
- `main` is an upstream mirror (fast-forward only). `fork/main` is the durable
  stable fork. Never routinely force-push either, or merge `dev` into stable.
- Upstream-bound `feature/*`, `fix/*`, `docs/*`, `chore/*` start from clean
  `main`. Keep personal patches out of their ancestry and complete PR diff.
- Fork-only work uses `personal/*` from `fork/main` (including personal fixes,
  documentation and deployment changes); never open an upstream PR for it.
- `sync/*` integrates upstream into `fork/main`; reconcile squash-merged PRs
  by code and behaviour, not SHA counts alone.
- `dev` is disposable integration of explicitly selected durable source
  branches. Keep its integration manifest current; never leave unique fixes
  only there. Accept ready source branches individually into `fork/main`.
- `release/*` starts from stable; return release fixes to `fork/main`. Prod
  deploys an immutable `fork-v<upstream-version>-<n>` tag's tested fork images
  by digest. Never substitute upstream images or rebuild during promotion.
- Branch names imply destination, not confidentiality. No secrets or unapproved
  personal data in Git. Never publish, commit, open PRs or deploy without the
  authorization required by the task and global guidance.
- Dev/Prod must have separate databases, secrets, media, uploads and backups.
  Run them with `./scripts/instance.sh <dev|prod> …`; never `podman-compose`
  directly, which would default to a shared project name. Both bind to loopback
  because instances have no login configured. Never test against live Prod,
  delete its volumes, or rebuild images during promotion. Verify schema
  compatibility before rollback.

## Pushing to Git

- Remotes: `origin` is the fork (`lamiskin/pokecollector`), `upstream` is
  `Git-Romer/pokecollector`. Never push to `upstream`. Confirm with
  `git remote -v` before the first push in a session.
- Push only after reviewing the exact range: `git log --oneline <base>..HEAD`,
  `git diff --stat <base>..HEAD`, and `git diff --check`. Never push a branch
  containing work you have not inspected.
- Before pushing, scan the added history for secrets and private data, e.g.
  `git log --format= --name-only <base>..HEAD | sort -u` then check for `.env`,
  `data/`, `backups/`, keys, dumps, photos and personal identifiers. The fork
  repository is **public**: `personal/*` is not private, only fork-scoped.
- Never commit or push scanned card photos, `test-images/`, database dumps,
  `.env*` files (templates are fine), auth keys or collection exports. The
  ignores exist for this reason; never force-add around them.
- `main` may only be pushed as a fast-forward of `upstream/main`. Never
  force-push `main`, `fork/main` or `dev`; if history must change, fix forward.
- Push durable source branches (`personal/*`), the integration branches and
  upstream PR branches you intend to open. Do not push throwaway experiment
  branches, and never use `--mirror`, `--all` or `--force` against `origin`.
- Release tags are immutable: push a tag once, never move or delete it.
- Report the pushed refs and their commits rather than claiming a push worked.
- **Purging committed data is the only sanctioned force-push**, and only with
  explicit authorization. Work from a bare mirror clone in a scratch directory,
  rewrite only fork commits (`git filter-branch … -- --all ^<upstream-base>`)
  so upstream commits and their tags stay byte-identical, verify the result,
  force-push every affected branch, then reset each local worktree to
  `origin/<branch>`. Take a `git bundle --all` backup first and never rewrite
  upstream history — it would detach the fork from future upstream merges.

## Verification

- Run focused tests during implementation; one integration owner runs the
  required full gates after reconciling changes. Use current package scripts
  and CI, not guessed tools. Documentation-only edits need link/command review
  and `git diff --check`, not the application test suite.
- This checkout has `frontend/package.json` scripts `test` (translation checks
  plus Vitest), `build`, and Playwright visual tests. It has no `lint` script.
- Backend tests use Python unittest; install dependencies from
  `backend/requirements.txt` in an isolated environment or disposable container.
  Do not assume pytest, Poetry, flake8 or mypy are configured.
  Check skip counts: dependency-guarded tests can skip when packages are missing;
  that is not evidence the affected behaviour passed.
- Consult current test/CI configuration for exact working directories and
  environment. Do not run tests in production containers.

## Quick start
- **Clone & configure**
  ```bash
  git clone https://github.com/lamiskin/pokecollector.git
  cd pokecollector
  git remote add upstream https://github.com/Git-Romer/pokecollector.git
  ```
- **Run an instance** (Dev shown; Prod uses `.env.prod` and its own ports)
  ```bash
  cp .env.dev.example .env.dev    # then fill in secrets; never commit
  mkdir -p instances/dev/{backups,auth,pokedex-images,scan-uploads,scan-traces}
  ./scripts/instance.sh dev up -d
  ```

  Dev serves `http://127.0.0.1:13000` (backend `18000`); Prod serves
  `http://127.0.0.1:3000` (backend `8000`). Each instance is its own Compose
  project with its own database volume, media and secrets.

## Development utilities
Run every command against an instance, not the bare Compose file:
```bash
./scripts/instance.sh dev exec backend python -m scripts.<module> [args]
```
- **Backfill Pokédex metadata** (first launch or after a DB upgrade)
  ```bash
  ./scripts/instance.sh dev exec backend python -m scripts.backfill_pokedex_metadata --limit 5000
  ```
  
- **Cache all species images – optional**
  ```bash
  ./scripts/instance.sh dev exec backend python -m scripts.cache_pokedex_images
  ```
- **Run tests** (isolated development environment only)
  ```bash
  # Full test suite
  ./scripts/instance.sh dev exec backend python -m unittest discover -s tests

  # Frontend only
  # The runtime frontend image serves static assets; use a source checkout
  # with its Node dependencies installed (or a disposable build container).
  cd frontend && npm test
  ```
- **Frontend build**
  ```bash
  cd frontend && npm run build
  ```

## Environment variables
Read the README for a full list, but key points:
- Each instance reads `.env.dev` / `.env.prod` (gitignored) through
  `scripts/instance.sh`. Never commit them; commit only the `.example` files.
- `POSTGRES_PASSWORD` – required; per-instance, never shared between Dev and Prod.
- `JWT_SECRET_KEY`, `ADMIN_PASSWORD` – critical for first-boot authentication; if unset, a random value is generated and stored under the instance's `AUTH_DIR`.
- `BACKEND_PORT` / `FRONTEND_PORT` – include a bind address; defaults are loopback.
- `BACKUPS_DIR`, `AUTH_DIR`, `POKEDEX_IMAGE_DIR`, `SCAN_UPLOAD_HOST_DIR`,
  `SCAN_TRACE_HOST_DIR` – keep each instance's state under `instances/<name>/`.
- `GEMINI_API_KEY` / `OPENAI_BASE_URL` – used by the scanner; leave unset in Dev unless you are deliberately testing one.
- In development you often leave `PUBLIC_MODE=false` so the site is not crawlable; it is not access control.

## Architecture
```text
repository/
├── backend/          # FastAPI services, database, scripts
├── frontend/         # React + Vite
├── scripts/instance.sh   # runs one isolated Dev or Prod stack
├── docs/FORK_*.md    # branch policy, runbook, deployment
├── instances/        # local state per instance (gitignored)
└── docker-compose.yml
```

## Common pitfalls
- **Never call `podman-compose` directly.** Without `--project-name` and an
  `--env-file`, it attaches to a shared project and can touch the wrong
  instance. Always go through `scripts/instance.sh`.
- **Database migrations** – inspect the current startup/migration code before changing schema; do not assume Alembic or Poetry. Back up and rehearse upgrades in Dev before touching Prod.
- **Ports** – Prod uses `8000`/`3000`, Dev `18000`/`13000`, both loopback. Change the instance's env file if occupied; never point two instances at one port.
- **Scan diagnostics** – files may contain sensitive photos/metadata. Inspect storage and retention first; do not delete traces or other data without authorization.
- **Rebuild after code changes** – building an image alone does not restart containers; use `./scripts/instance.sh <instance> build <service>` then `up -d` (or `down` first), and compare image IDs.

## Running a development backend shell
From the repo root:
```bash
./scripts/instance.sh dev exec backend sh
# Now you're inside the Dev backend container.
```

## Adding a new dev dependency
Update the project's actual dependency manifest (`backend/requirements.txt` in
this checkout), install in the isolated development environment, and rebuild
the backend image when validating container behaviour.

---

This file is read by Opencode to provide the agent with concise, accurate commands for everyday work. Keep it up‑to‑date as the repo evolves.
