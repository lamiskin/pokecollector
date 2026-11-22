#!/usr/bin/env bash
# Take a verified database backup of one PokéCollector instance.
#
#   ./scripts/backup-instance.sh prod
#   ./scripts/backup-instance.sh dev
#   BACKUP_RETENTION=14 ./scripts/backup-instance.sh prod
#
# A dump is a complete backup of the instance: collection photos are stored in
# the database (`collection_card_photos.data`), not on disk, and the media
# directories under instances/<name>/ are empty by design. AUTH_DIR likewise
# holds nothing once keys are written to the container's own volume.
#
# Output layout matches the verified 2026-11-03 cutover backups:
#
#   <backups>/<YYYY-MM-DD>/<db>-<YYYY-MM-DD>.dump      pg_dump custom format
#   <backups>/<YYYY-MM-DD>/<db>-<YYYY-MM-DD>.sql.gz    gzipped plain SQL
#   <backups>/<YYYY-MM-DD>/SHA256SUMS                  checksums of both
#
# The custom dump is the restore path (`pg_restore`); the SQL.gz is the
# human-readable fallback. Both are written from the same database state and
# then checksummed, so a truncated or corrupt file is caught on the spot.
#
# Exit codes: 0 success, 1 usage/setup error, 2 dump or verification failed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

usage() {
  echo "usage: $0 <dev|prod>" >&2
  exit 1
}

[ $# -eq 1 ] || usage
instance=$1
case "$instance" in
  dev|prod) ;;
  *) usage ;;
esac

env_file="${REPO_ROOT}/.env.${instance}"
[ -f "$env_file" ] || { echo "missing ${env_file}" >&2; exit 1; }

# Never source the env file: it holds secrets, and sourcing would put them in
# this process's environment. Values are read with sed instead.
compose_project="pokecollector-${instance}"
backups_root="${BACKUP_ROOT:-$HOME/backups/pokecollector}"
retention="${BACKUP_RETENTION:-7}"
date_stamp="$(date +%Y-%m-%d)"
timestamp="$(date +%Y-%m-%dT%H:%M:%S%z)"
target_dir="${backups_root}/${date_stamp}"

log() { printf '[backup %s] %s\n' "$instance" "$*"; }
fail() { printf '[backup %s] ERROR: %s\n' "$instance" "$*" >&2; exit 2; }

# The instance must be running; there is no offline path for a rootless volume.
container="$(podman ps --format '{{.Names}}' --filter "label=io.podman.compose.project=${compose_project}" --filter name=postgres | head -n1)"
[ -n "$container" ] || { echo "[backup ${instance}] postgres is not running for ${compose_project}" >&2; exit 1; }

db_user="$(sed -n "s/^POSTGRES_USER=//p" "$env_file")"
db_name="$(sed -n "s/^POSTGRES_DB=//p" "$env_file")"
db_user="${db_user:-pokemon}"
db_name="${db_name:-pokemon_tcg}"

mkdir -p "$target_dir"

custom_dump="${target_dir}/${db_name}-${date_stamp}.dump"
sql_dump="${target_dir}/${db_name}-${date_stamp}.sql.gz"

# Keep one backup per day: a second run on the same day overwrites that day's
# files rather than piling up near-duplicates.
log "dumping ${db_name} from ${container} (${compose_project})"

# pg_dump runs inside the container so the server version always matches the
# client version. -Fc is the restorable artifact; the plain SQL is streamed and
# compressed on the host in the same run.
if ! podman exec "$container" pg_dump -U "$db_user" -d "$db_name" -Fc -f /tmp/pc-backup.dump; then
  fail "pg_dump (custom format) failed"
fi
if ! podman cp "${container}:/tmp/pc-backup.dump" "${custom_dump}.partial"; then
  fail "could not copy custom dump out of the container"
fi

if ! podman exec "$container" pg_dump -U "$db_user" -d "$db_name" -Fp | gzip -9 > "${sql_dump}.partial"; then
  fail "pg_dump (plain SQL) failed"
fi

# Clean up the container-side staging file whether or not the copies worked.
podman exec "$container" rm -f /tmp/pc-backup.dump || true

# Verification before anything is promoted into place: a dump that does not
# identify itself as PGDMP or decompresses to nothing is not a backup.
head -c 5 "${custom_dump}.partial" | grep -q '^PGDMP$' || fail "custom dump is not a PGDMP archive"
gzip -t "${sql_dump}.partial" || fail "plain SQL dump is not valid gzip"
[ -s "${custom_dump}.partial" ] || fail "custom dump is empty"
[ -s "${sql_dump}.partial" ] || fail "plain SQL dump is empty"
# grep -q exits at the first match and closes the pipe, so zcat dies of SIGPIPE
# (141) and pipefail would turn a successful match into a failure. Read the
# decode to completion and test the captured text instead.
sql_head="$(zcat "${sql_dump}.partial" | sed -n '1,20p')"
case "$sql_head" in
  *"PostgreSQL database dump"*) ;;
  *) fail "plain SQL dump does not look like a pg_dump output" ;;
esac

mv "${custom_dump}.partial" "$custom_dump"
mv "${sql_dump}.partial" "$sql_dump"

# Checksums cover both artifacts, in the same format as the verified
# 2026-11-03 backups.
( cd "$target_dir" && sha256sum "$(basename "$custom_dump")" "$(basename "$sql_dump")" > SHA256SUMS )

(
  cd "$target_dir"
  sha256sum -c --quiet SHA256SUMS
) || fail "checksum verification failed"

# A dump that restores to the right shape is the only evidence that matters.
# Read the row count straight out of the plain SQL rather than trusting size.
log "$(du -h "$custom_dump" | cut -f1) custom, $(du -h "$sql_dump" | cut -f1) gzipped, checksums verified"

printf '%s %s %s\n' "$timestamp" "$instance" "$target_dir" >> "${backups_root}/backup.log"

# Retain the newest $retention dated directories, and always keep the
# 2026-11-03 cutover backup even once it falls out of the window: it is the
# verified pre-fork artifact referenced by docs/FORK_DEPLOYMENT.md.
PINNED_DATE="2026-11-03"
if [ "$retention" -gt 0 ]; then
  mapfile -t dated < <(find "$backups_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r)
  if [ "${#dated[@]}" -gt "$retention" ]; then
    for old in "${dated[@]:$retention}"; do
      if [ "$old" = "$PINNED_DATE" ]; then
        log "keeping pinned cutover backup ${old}"
        continue
      fi
      log "pruning ${backups_root}/${old}"
      rm -rf -- "${backups_root:?}/${old}"
    done
  fi
fi

log "done: ${target_dir}"
