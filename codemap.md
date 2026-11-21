# PokéCollector fork — repository map

## Responsibility

A self-hosted Pokémon TCG collection manager. The repository combines a FastAPI
backend, React/Vite frontend, PostgreSQL persistence, upstream data/pricing
integrations, and scripts to run isolated fork Dev and Prod instances. This
map describes the current `fork/main` target structure, not the retained legacy
`testing` checkout.

## Design

- **Backend:** HTTP routers in `backend/api/` call domain services in
  `backend/services/`; services use SQLAlchemy models and PostgreSQL. The
  FastAPI lifespan handles migration/bootstrap/scheduler startup.
- **Frontend:** `frontend/src/main.jsx` mounts the React app; `App.jsx` composes
  auth/settings/confirmation providers and routes to lazy page containers.
  Pages combine API clients, hooks, utilities and reusable components.
- **Runtime:** `docker-compose.yml` defines the stack; `scripts/instance.sh`
  selects the isolated `pokecollector-dev` or `pokecollector-prod` project and
  its ignored environment/data paths. Frontend nginx serves the SPA and proxies
  `/api` traffic to the backend on the private Compose network.
- **Fork policy:** `main` mirrors upstream; `fork/main` is the stable fork;
  `dev` is an integration branch. See `docs/FORK_WORKFLOW.md` and
  `docs/FORK_RUNBOOK.md` for branch and release flow.

## Flow

Browser request → frontend static app/nginx → frontend API client → nginx
`/api` proxy → FastAPI middleware/auth/router → service layer → PostgreSQL or
external catalog/pricing/scanner providers → JSON response → React Query/state
updates and rendered page. Background scheduler and explicit sync endpoints
share the service layer for catalogue, price, and maintenance work.

## Integration

| Directory | Responsibility | Map |
|---|---|---|
| `backend/` | FastAPI entrypoint, SQLAlchemy persistence, API and domain services | [backend/codemap.md](backend/codemap.md) |
| `backend/api/` | HTTP routers, auth dependencies, request/response contracts | [backend/api/codemap.md](backend/api/codemap.md) |
| `backend/services/` | Domain logic, synchronization, prices, scanning, jobs | [backend/services/codemap.md](backend/services/codemap.md) |
| `backend/scripts/` | One-off administrative and maintenance commands | [backend/scripts/codemap.md](backend/scripts/codemap.md) |
| `frontend/` | Vite build and nginx-served SPA runtime | [frontend/codemap.md](frontend/codemap.md) |
| `frontend/src/` | React app bootstrap, routes and UI source atlas | [frontend/src/codemap.md](frontend/src/codemap.md) |
| `frontend/src/api/` | Authenticated and public HTTP clients | [frontend/src/api/codemap.md](frontend/src/api/codemap.md) |
| `frontend/src/components/` | Shared visual components and feature subareas | [frontend/src/components/codemap.md](frontend/src/components/codemap.md) |
| `frontend/src/components/binders/` | Binder CSV import UI | [codemap](frontend/src/components/binders/codemap.md) |
| `frontend/src/components/card-lists/` | Reusable card gallery and picker | [codemap](frontend/src/components/card-lists/codemap.md) |
| `frontend/src/components/card-system/` | Shared card display primitives and pricing | [codemap](frontend/src/components/card-system/codemap.md) |
| `frontend/src/components/decks/` | Deck validation, analytics and display components | [codemap](frontend/src/components/decks/codemap.md) |
| `frontend/src/components/public/` | Shared public-profile layout | [codemap](frontend/src/components/public/codemap.md) |
| `frontend/src/components/ui/` | Accessible shared UI primitives | [codemap](frontend/src/components/ui/codemap.md) |
| `frontend/src/contexts/` | Auth, settings and confirmation state | [frontend/src/contexts/codemap.md](frontend/src/contexts/codemap.md) |
| `frontend/src/hooks/` | Reusable stateful React behaviors | [frontend/src/hooks/codemap.md](frontend/src/hooks/codemap.md) |
| `frontend/src/pages/` | Route-level private and public page containers | [frontend/src/pages/codemap.md](frontend/src/pages/codemap.md) |
| `frontend/src/utils/` | Shared pure/domain helper functions | [frontend/src/utils/codemap.md](frontend/src/utils/codemap.md) |
| `frontend/scripts/` | Translation and runtime-configuration checks | [frontend/scripts/codemap.md](frontend/scripts/codemap.md) |
| `scripts/` | Instance management and repository maintenance tools | [scripts/codemap.md](scripts/codemap.md) |

Root configuration and entrypoints: `docker-compose.yml`,
`docker-compose.build.yml`, `VERSION`, `AGENTS.md`, `backend/main.py`,
`frontend/vite.config.js`, and `scripts/instance.sh`. Tests, documentation,
translations, build artifacts and vendored dependencies are intentionally
excluded from the codemap state; consult `README.md` and `docs/` for those.
