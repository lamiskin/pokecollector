#!/bin/sh
# Clear the Dev capture lab's stored captures after a deploy.
#
# The lab keeps every capture it stages, and a capture from an earlier build
# (old thresholds, old interaction) sitting beside a new one makes a comparison
# meaningless. Diagnostics are deliberately kept: they are the measurement
# history the tuning decisions are made from.
#
# The lab data lives under whichever checkout owns `instances/`, which is not
# necessarily this worktree, so find it among the repo's worktrees.
#
# Usage: scripts/clear-capture-lab.sh [instance]   (default: dev)
set -eu

instance="${1:-dev}"
root="$(cd "$(dirname "$0")/.." && pwd)"

dir=""
for wt in $(git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p'); do
  candidate="${wt}/instances/${instance}/capture-lab"
  if [ -d "${candidate}" ]; then
    dir="${candidate}"
    break
  fi
done

if [ -z "${dir}" ]; then
  echo "no ${instance} capture-lab directory in any worktree of ${root}" >&2
  exit 0
fi

before=$(find "${dir}" -maxdepth 1 -type f -name '*-capture.jpg*' | wc -l)
find "${dir}" -maxdepth 1 -type f -name '*-capture.jpg*' -delete
after=$(find "${dir}" -maxdepth 1 -type f -name '*-capture.jpg*' | wc -l)
diagnostics=$(find "${dir}/diagnostics" -type f 2>/dev/null | wc -l)

echo "cleared ${before} capture file(s) from ${instance} (${dir}); ${after} remain; kept ${diagnostics} diagnostics recording(s)"
