#!/bin/sh
set -eu

# Widen the Content-Security-Policy for the on-device card detector, and only
# when that detector is actually served.
#
# `script-src 'wasm-unsafe-eval'` is what lets the browser compile the detector's
# ONNX runtime; without it every attempt fails with "no available backend found"
# and a CompileError naming script-src. `worker-src 'self'` is for the inference
# worker. Both are narrower than 'unsafe-eval': they permit compiling
# WebAssembly, not running arbitrary script from strings.
#
# The policy is written in two places - inline at server level, and in the
# snippet that locations with their own `add_header` must include - and a
# location that includes the snippet drops the inherited server-level headers.
# So a page is only as permissive as the snippet, and both have to be widened or
# the lab fails while the headers look correct on the pages that do not include
# it.
#
# Off by default: an image that does not serve the detector keeps the strict
# policy upstream ships and tests assert.

flag() {
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "${value}" in
    true|1|yes|on) echo 1 ;;
    *) echo 0 ;;
  esac
}

[ "$(flag "${DETECTOR_ENABLED:-}")" = 1 ] || exit 0

csp_files="/etc/nginx/conf.d/default.conf /etc/nginx/snippets/pc-security-headers.conf"

for file in $csp_files; do
  [ -f "$file" ] || continue
  # Idempotent across restarts, and careful not to match the explanatory comment
  # above the directive: only the directive itself counts as already widened.
  grep -q "script-src 'self' 'wasm-unsafe-eval'" "$file" && continue
  sed -i "s|script-src 'self';|script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';|g" "$file"
  echo "detector: enabled 'wasm-unsafe-eval' in $file"
done
