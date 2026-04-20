#!/usr/bin/env bash
# zynd-deployer base-image entrypoint.
#
# If the user's project shipped a requirements.txt, install it into a
# tmpfs-backed path that's prepended to PYTHONPATH. The root filesystem
# is mounted read-only, so we can't just `pip install` into site-packages
# without breaking the security posture.
set -euo pipefail

EXTRA_DIR="/tmp/user-packages"
REQ_FILE="/app/requirements.txt"

if [[ -f "$REQ_FILE" ]]; then
  mkdir -p "$EXTRA_DIR"
  # --target keeps the install scoped; --no-compile skips .pyc creation
  # on a read-only overlay to avoid pointless I/O.
  pip install \
    --no-cache-dir \
    --no-compile \
    --target "$EXTRA_DIR" \
    -r "$REQ_FILE"
  export PYTHONPATH="$EXTRA_DIR:${PYTHONPATH:-}"
fi

exec "$@"
