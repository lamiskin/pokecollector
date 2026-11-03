# Running Dev and Prod from this fork

This is the fork-specific companion to [DEPLOYMENT.md](DEPLOYMENT.md), which
describes upstream's single-instance install with published images. This fork
cannot use those images — they lack its features — so it builds its own.

Two independent instances run from this checkout as separate Compose projects:
`pokecollector-dev` and `pokecollector-prod`. They share code, never state.

Everything below is the operational companion to [FORK_RUNBOOK.md](FORK_RUNBOOK.md).
Nothing here is run automatically; each step is deliberate.

## What is isolated

| Concern | How |
|---|---|
| Compose project, containers, network | `--project-name pokecollector-<instance>` in `scripts/instance.sh` |
| Database | the project-scoped `postgres_data` volume |
| Media, auth keys, backups | `BACKUPS_DIR`, `AUTH_DIR`, `POKEDEX_IMAGE_DIR`, `SCAN_UPLOAD_HOST_DIR`, `SCAN_TRACE_HOST_DIR` in the instance env file |
| Secrets | separate `.env.dev` / `.env.prod`, never committed |
| Host ports | `BACKEND_PORT` / `FRONTEND_PORT` |
| Outbound side effects | Dev must leave Telegram unset; scanner use is deliberate |

The base Compose file no longer hard-codes container names or relative data
paths, which is what makes two stacks on one machine safe.

## First-time setup

```bash
cp .env.dev.example  .env.dev
cp .env.prod.example .env.prod
# edit both: generate POSTGRES_PASSWORD and JWT_SECRET_KEY with
#   openssl rand -hex 32
# set ADMIN_PASSWORD; keep Dev's Telegram values empty
mkdir -p instances/dev/{backups,auth,pokedex-images,scan-uploads,scan-traces}
mkdir -p instances/prod/{backups,auth,pokedex-images,scan-uploads,scan-traces}
```

`instances/` and the `.env.*` files are gitignored.

## Build the fork images once

Prod must run the same bytes that were tested in Dev, so build once and pin.

```bash
./scripts/instance.sh prod build --no-cache backend frontend
podman image inspect pokecollector-backend:prod pokecollector-frontend:prod \
  --format '{{.Id}} {{.RepoDigests}}'   # record both in the release manifest
```

## Seed an instance

### Dev

Use an approved one-way copy of a Prod backup, or start empty:

```bash
./scripts/instance.sh dev up -d postgres
./scripts/instance.sh dev exec -T postgres \
  pg_restore -U pokemon -d pokemon_tcg --clean --if-exists < backup.dump
./scripts/instance.sh dev up -d
```

A Dev copy is a snapshot; it never syncs back.

### Prod (first cutover)

The authoritative collection is the local volume
`pokecollector_postgres_data` (168 rows, 176 copies, 168 own photos, verified
2026-11-03). Logical backups are in `~/backups/pokecollector/2026-11-03` and on
another host in `/opt/backups/pokecollector/2026-11-03`.

1. Take a fresh backup immediately before cutover.
2. Start only the new Prod database, restore into it, then start the app.
3. Verify counts, photos and login before pointing anything at it.
4. Keep the old containers and volume until the new stack is confirmed.

## Day-to-day

```bash
./scripts/instance.sh dev  up -d
./scripts/instance.sh dev  logs -f backend
./scripts/instance.sh prod ps
```

Do not run tests, migrations or experiments against Prod. Schema changes are
rehearsed in Dev first, with a copy of the Dev database taken beforehand.

## Upgrade and release

1. Accept work into `fork/main`.
2. Cut `release/<version>-fork.<n>` from it and freeze the commit.
3. Build images from that commit; label and record their IDs.
4. Deploy those exact images to Dev, run the migrations and smoke-test.
5. Only then pin the same images in `.env.prod` and restart Prod.
6. Record the release tag, image IDs, backup used and verification results.

## Rollback

- Code only, schema compatible: point `.env.prod` back at the previous image IDs.
- Schema changed: restore the matching database backup **and** the previous
  images, accepting loss of writes since that backup. Confirm schema
  compatibility before attempting an image-only rollback.
- Never delete the `postgres_data` volume as cleanup.

## Moving Prod to another host

Both instances currently run on the development desktop. To move Prod: build or
export the images, copy the dump plus `instances/prod` media, and set up the
target's `.env.prod` with its own ports. The old host's data stays until the new
one is verified.
