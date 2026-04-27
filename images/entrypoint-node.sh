#!/usr/bin/env bash
# zynd-deployer node base-image entrypoint.
#
# If the user's project shipped a package-lock.json, run `npm ci` to install
# their exact dependency tree into /tmp/user-modules (a writable tmpfs path).
# If only package.json is present, fall back to `npm install`.
# NODE_PATH is extended so `import "zyndai"` first resolves against the
# user's pinned copy, then falls back to the base layer at /opt/zynd-base.
#
# /app is bind-mounted read-only by the worker so we must not write there.
# /tmp is already a tmpfs (worker/docker.ts: Tmpfs: { "/tmp": "rw,exec,size=64m" }).
set -euo pipefail

EXTRA_DIR="/tmp/user-modules"

if [[ -f /app/package-lock.json ]]; then
  mkdir -p "$EXTRA_DIR"
  cp /app/package.json /app/package-lock.json "$EXTRA_DIR"/
  ( cd "$EXTRA_DIR" && npm ci --omit=dev --no-audit --no-fund )
  export NODE_PATH="$EXTRA_DIR/node_modules:${NODE_PATH:-}"
elif [[ -f /app/package.json ]]; then
  mkdir -p "$EXTRA_DIR"
  cp /app/package.json "$EXTRA_DIR"/
  ( cd "$EXTRA_DIR" && npm install --omit=dev --no-audit --no-fund )
  export NODE_PATH="$EXTRA_DIR/node_modules:${NODE_PATH:-}"
fi

exec "$@"
