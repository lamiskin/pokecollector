# PokéCollector

## Fork workflow (read first)

- Policy and naming: [docs/FORK_WORKFLOW.md](docs/FORK_WORKFLOW.md).
- Procedures: [docs/FORK_RUNBOOK.md](docs/FORK_RUNBOOK.md).
- These describe the target workflow. Existing `testing`/`prod` are legacy;
  do not reset, rename, delete or migrate them implicitly.
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
  Root Compose currently hard-codes container names and relative bind mounts;
  project names alone cannot make it dual-instance-safe. Never test against
  live Prod or delete its volumes. Verify schema compatibility before rollback.

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
  cp .env.example .env   # local-only credentials; never commit
  ```
- **Single-instance local development only** (not the future dual-instance setup):
  ```bash
  mkdir -p data/pokedex-images backups
  podman-compose up -d
  ```
  
  The backend listens on `http://localhost:8000`, the frontend on `http://localhost:3000`.

## Development utilities
- **Run a single backend script**
  ```bash
  podman-compose exec backend python -m scripts.<module> [args]
  ```
- **Backfill Pokédex metadata** (first launch or after a DB upgrade)
  ```bash
  podman-compose exec backend python -m scripts.backfill_pokedex_metadata --limit 5000
  ```
  
- **Cache all species images – optional**
  ```bash
  podman-compose exec backend python -m scripts.cache_pokedex_images
  ```
- **Run tests** (isolated development environment only)
  ```bash
  # Full test suite
  podman-compose exec backend python -m unittest discover -s tests

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
- `POSTGRES_PASSWORD` – required, password for the `postgres` container.
- `JWT_SECRET_KEY`, `ADMIN_PASSWORD` – critical for first‑boot authentication; if unset, a random value is generated and stored under `data/auth/`.
- `GEMINI_API_KEY` / `OPENAI_BASE_URL` – used by the scanner.
- In development you often leave `PUBLIC_MODE=false` so the site is not crawlable.

## Architecture
```text
pokecollector/
├── backend/   # FastAPI services, database, scripts
├── frontend/  # React 18 + Vite
└── docker-compose.yml
```

## Common pitfalls
- **Database migrations** – inspect the current startup/migration code before changing schema; do not assume Alembic or Poetry. Back up and rehearse upgrades in Dev before touching Prod.
- **Port conflicts** – the Compose file publishes to host‑controlled ports (`8000` and `3000`). Change `BACKEND_PORT` / `FRONTEND_PORT` env vars if those ports are occupied.
- **Scan diagnostics** – files may contain sensitive photos/metadata. Inspect storage and retention first; do not delete traces or other data without authorization.

## Running a development backend shell
From the repo root:
```bash
podman-compose exec backend sh
# Now you’re inside the development backend container, ready to run Python.
```

## Adding a new dev dependency
Update the project's actual dependency manifest (`backend/requirements.txt` in
this checkout), install in the isolated development environment, and rebuild
the backend image when validating container behaviour.

---

This file is read by Opencode to provide the agent with concise, accurate commands for everyday work. Keep it up‑to‑date as the repo evolves.
