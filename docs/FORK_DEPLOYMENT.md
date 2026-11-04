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
| Host ports | `BACKEND_PORT` / `FRONTEND_PORT`, including a bind address |
| Exposure | backends stay on loopback; frontends may bind the netbird address, which requires a matching UFW rule and login enabled |
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

### Exposing a frontend on the netbird interface

The backends stay on loopback; the frontend proxies `/api` to the backend inside
the Compose network, so nothing else needs publishing. To reach a UI from other
netbird devices, bind only the frontend:

```bash
# .env.prod
FRONTEND_PORT=100.64.0.10:3000
# .env.dev
FRONTEND_PORT=100.64.0.10:13000
```

Then allow the port on that interface, or UFW's default deny will drop it:

```bash
sudo ufw allow in on wt0 to any port 3000 proto tcp comment 'pokecollector prod'
sudo ufw allow in on wt0 to any port 13000 proto tcp comment 'pokecollector dev'
sudo ufw status numbered
```

Two rules of thumb:

- The bind address is a literal netbird IP. If it changes, `up` fails to start
  the frontend until the env file is updated; check `ip -br addr show wt0`.
- Binding a frontend off loopback exposes an instance with **no login** unless
  `USER_MODE=multi` is set. Set it for Prod before widening access, and confirm
  the login screen appears before relying on the firewall alone.

### Authentication

Prod runs with `USER_MODE=multi` (login required); Dev deliberately does not.
Check with `curl -o /dev/null -w '%{http_code}' http://<host>:<port>/api/collection/`
— 401 means login is enforced, 200 means the instance is open.

A restored database brings its own `users` rows, so the password in `.env.prod`
does **not** apply after a restore. Reset it from inside the instance:

```bash
./scripts/instance.sh prod exec backend \
  python -m scripts.set_admin_password --username admin --password '<new-password>'
```

Then confirm a real login through the frontend, not just the API.

### Native OIDC sign-in

Both instance env examples carry `AUTH_MODE` and the `OIDC_*` settings, but
OIDC stays off while `AUTH_MODE=local`. Native OIDC is optional and
per-instance: configuring Dev never enables it on Prod, and it does not change
the Compose project, volume or media isolation above.

- Start an existing instance in `AUTH_MODE=mixed`, link the administrator from
  Settings, then switch to `oidc-only` if password login should be disabled.
- `oidc-only` refuses to start without an active linked administrator. OIDC
  issuer/redirect URIs must be HTTPS, or plain HTTP only for literal loopback
  development.
- `OIDC_CLIENT_SECRET` belongs only in the private instance env file.

See [OpenID Connect Authentication](OIDC_AUTHENTICATION.md) for provider
registration, account linking, recovery and the security model.

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

The authoritative collection was the old local volume
`pokecollector_postgres_data` (168 rows, 176 copies, 168 own photos, verified
2026-11-03). Its verified backups are in `~/backups/pokecollector/2026-11-03`,
with an off-host copy under `/opt/backups/pokecollector/2026-11-03`. Prod was
seeded from that dump on 2026-11-03; repeat the procedure only when rebuilding
or re-seeding an instance.

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
