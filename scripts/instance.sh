#!/usr/bin/env bash
# Run docker-compose for one isolated PokéCollector instance.
#
#   ./scripts/instance.sh dev up -d
#   ./scripts/instance.sh prod ps
#
# The instance name selects the env file (.env.dev / .env.prod) and the compose
# project, so the two stacks share a checkout but never a container name,
# database volume, network or media directory.
set -euo pipefail

usage() {
  echo "usage: $0 <dev|prod> <docker-compose arguments...>" >&2
  exit 2
}

[ $# -ge 2 ] || usage
instance=$1
shift

case "$instance" in
  dev|prod) ;;
  *) usage ;;
esac

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
env_file="$root/.env.$instance"
compose_file="$root/docker-compose.yml"

if [ ! -f "$env_file" ]; then
  echo "missing $env_file — copy .env.$instance.example and fill it in" >&2
  exit 1
fi

compose_bin=${COMPOSE_BIN:-podman-compose}

exec "$compose_bin" \
  --project-name "pokecollector-$instance" \
  --env-file "$env_file" \
  -f "$compose_file" \
  "$@"
