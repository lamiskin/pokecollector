# scripts/

## Responsibility

Repository-root operational and maintenance tooling, distinct from
`backend/scripts/` (Python one-off admin commands run *inside* the backend
container) and `frontend/scripts/` (translation and runtime-configuration
checks). These five tools run on the host, outside the application:

- **`instance.sh`** — the single, documented entrypoint for running an isolated
  Dev or Prod Compose stack, so the two environments share one checkout but
  never a container name, database volume, network, or media directory.
- **`check-compose-ports.mjs`** (+ `.test.mjs`) — a guard that the
  `docker-compose.yml` host-port mappings stay parameterised and pinned to
  stable defaults, preventing an empty `BACKEND_PORT`/`FRONTEND_PORT` from
  silently receiving an ephemeral host port.
- **`check-version.mjs`** — a release-consistency guard that the `VERSION` file,
  the frontend package manifests, the Compose image tags, and the README badge
  all agree.
- **`update-rescue-donation-total.mjs`** — regenerates the historic
  animal-rescue donation total in `README.md` from `RESCUE_DONATIONS.csv`.
- **`upgrade-postgres-15-to-18.sh`** — an interactive, dump/restore major-version
  upgrade for the Docker-managed PostgreSQL data volume, with a rollback path.

Nothing here is imported by the application; the two `.mjs` validators are wired
into GitHub Actions, and the shell scripts are operator-facing.

## Design

Two tool patterns recur:

1. **Pure-function + standalone-main ESM validators.** `check-compose-ports.mjs`
   exports `checkComposePorts(compose)` and only reads the file when executed
   directly (`process.argv[1] === import.meta.url`). This makes the logic
   unit-testable in `check-compose-ports.test.mjs`, which loads the real
   `docker-compose.yml` as a fixture and mutates it with `replaceOnce`
   (asserting the substring exists before replacing). Both scripts resolve the
   repo root via `import.meta.dirname` and exit non-zero with errors on stderr.

2. **Defensive `set -euo pipefail` Bash with explicit recovery.** `instance.sh`
   guards its arguments and env file, then `exec`s Compose. The upgrade script
   traps `ERR` with `on_error` and prints dump path + rollback volume before
   exiting, and gates destructive steps behind a typed confirmation string.

Specific decisions:

- **Colon-default port enforcement.** `check-compose-ports.mjs` requires the
  quoted short-syntax `"${BACKEND_PORT:-8000}:8000"` (and
  `"${FRONTEND_PORT:-3000}:80"`) and explicitly rejects the `${VAR-8000}`
  form: with the colon, an unset *or empty* variable keeps the stable default
  host port, whereas `${VAR-8000}` yields an empty string and an ephemeral
  port. A fully hardcoded `8000:8000` mapping is also rejected.
- **Line-based Compose parsing instead of a YAML library.** Because the check
  must not be fooled by a service-shaped block parked under an `x-` extension,
  it scans only the real `services:` section (`servicesLines`), each service's
  own `ports:` list (`serviceLines` + `portEntries`), skipping comments and
  blanks (`isIgnorable`), keyed off indentation (`indentOf`). The test suite
  proves an `x-templates` decoy can neither satisfy nor mask a broken service.
- **Version is a single source of truth.** `VERSION` must be both valid SemVer
  and a valid Docker tag; `check-version.mjs` then cross-checks it against
  `frontend/package.json`, `frontend/package-lock.json` (both its top-level
  `version` and `packages[""].version`), the release image tags
  `ghcr.io/git-romer/pokecollector-{backend,frontend}:${POKECOLLECTOR_VERSION:-<v>}`
  in `docker-compose.yml`, and the README badge/text. The README checks are
  skippable (`--skip-readme` / `SKIP_README_VERSION_CHECK=true`) for CI steps
  where the README is not yet updated.
- **Hand-rolled CSV.** `update-rescue-donation-total.mjs` parses
  `RESCUE_DONATIONS.csv` itself (quote/escaped-quote aware), rather than adding
  a dependency, validates the required headers (`date, amount, currency,
  organization, url, note`), treats a comma decimal separator as a dot, and
  only sums positive finite amounts. The currency is the first row's, or
  `MIXED` when rows disagree; output is `€`/`$`/`£` prefixed or `"<amount>
  <code>"`. It rewrites only the block between the
  `<!-- rescue-donation-total:start -->` / `:end -->` markers and errors if the
  marker is absent.

## Flow

**Isolated instance run (the normal path).** `./scripts/instance.sh dev up -d`
selects `.env.dev` and the `pokecollector-dev` project, then `exec`s
`podman-compose --project-name pokecollector-dev --env-file .env.dev -f
docker-compose.yml up -d`. `prod` differs only by name. Every documented
command in `AGENTS.md` and `docs/FORK_DEPLOYMENT.md` routes through this
wrapper; `COMPOSE_BIN` overrides the compose binary (default `podman-compose`).

**Postgres 15 → 18 upgrade (one-time, interactive).**
`./scripts/upgrade-postgres-15-to-18.sh` drives `docker compose` (not
`podman-compose`):

1. Locate the source: a running `postgres` container, else a stopped one, else
   a PG15 volume discovered by Compose labels or the default project-name
   volume (`COMPOSE_PROJECT_NAME`, defaulting to the repo basename).
2. Detect the major version either via `psql SHOW server_version_num` or by
   mounting the volume read-only into `alpine:3.22` and reading `PG_VERSION`
   (`detect_volume_pg_major`, which also distinguishes `/var/lib/postgresql`
   from `/var/lib/postgresql/data`).
3. Guard: already 18 → no-op; non-15 source → fail unless
   `ALLOW_NON_15_SOURCE=true`; 18 running over legacy 15 data → fail (the
   `docker-compose.yml` postgres entrypoint itself refuses to start in that
   case).
4. After a typed confirmation, stop app services, `pg_dump --clean --if-exists`
   to a timestamped `.sql` under `backups/` — using a temporary PG15 container
   when only the volume survives (the "ran `compose up` first" case).
5. `compose down`, tar-copy the old volume to a rollback volume
   `<vol>_pg15_backup_<ts>`, delete the old volume, `up -d postgres`, wait for
   `pg_isready`, verify the actual major, then restore with
   `psql -v ON_ERROR_STOP=1`.
6. `pull backend frontend` + `up -d`, then verify by counting public tables.

**Version consistency.** GitHub Actions runs `node scripts/check-version.mjs`
and `node scripts/check-compose-ports.mjs` (plus the port tests) on any PR/push
touching the version- or compose-sensitive files; the release workflow runs
`check-version.mjs --skip-readme`. All are pure read-only checks that exit 1 on
the first batch of errors.

**Donation total refresh.** After editing `RESCUE_DONATIONS.csv`, run
`node scripts/update-rescue-donation-total.mjs` to rewrite the README total
in-place.

## Integration

- **Compose stack (`docker-compose.yml`):** `instance.sh` selects the project
  and env file; `check-compose-ports.mjs` pins the backend/frontend host-port
  mappings; the postgres container's entrypoint guard points operators at the
  upgrade script when it finds pre-18 data. There is also
  `docker-compose.build.yml` (build-only), which the version check's CI paths
  include.
- **Release/CI (`docs/`, `.github/workflows/`):** `version-check.yml` runs the
  two validators and the port test suite; `release.yml` runs
  `check-version.mjs --skip-readme`; `CONTRIBUTING.md` lists
  `node scripts/check-version.mjs` as a local pre-flight.
- **Frontend package manifests:** `check-version.mjs` reads
  `frontend/package.json` and `frontend/package-lock.json` and requires their
  version to match `VERSION`.
- **README.md:** `check-version.mjs` asserts the version badge and "Current
  version" line; `update-rescue-donation-total.mjs` owns the
  `<!-- rescue-donation-total -->` block; the upgrade/donation workflow is
  documented there alongside `RESCUE_DONATIONS.csv`.
- **Sibling script folders (distinct scope):** `backend/scripts/` are Python
  maintenance commands executed through
  `./scripts/instance.sh <instance> exec backend python -m scripts.<module>`;
  `frontend/scripts/` are translation/runtime-configuration checks. This folder
  is the host-side glue between checkout, Compose, and CI.
