#!/usr/bin/env bash
# zynd-deployer node base-image entrypoint.
#
# Why this is more involved than the python entrypoint:
#
#   Node's ESM resolver walks node_modules along the *importing file's*
#   directory tree only. NODE_PATH is silently ignored for bare specifiers
#   in ESM. So a setup like "user source at /app, deps at /tmp/foo,
#   NODE_PATH=/tmp/foo" works for CJS but fails ESM with
#   ERR_MODULE_NOT_FOUND.
#
#   /app is bind-mounted read-only by the worker, so we cannot install
#   node_modules into /app directly. Instead we copy /app into a writable
#   tmpfs path ($APP_DIR), run npm install there, and rewrite any
#   /app/<file> argument to $APP_DIR/<file> before exec'ing the start
#   command. The worker keeps issuing the same /app/<entry>.ts CMD.
#
# Tmpfs sizing: /tmp is sized by DEPLOYER_CONTAINER_TMPFS_MB
# (worker/docker.ts). Default 512MB — enough for a copy of /app plus a
# typical node_modules. Bump it if a deploy hits ENOSPC during npm.

set -euo pipefail

APP_DIR="/tmp/user-app"

# Rootfs is read-only (worker/docker.ts: ReadonlyRootfs=true). npm
# defaults to /root/.npm for cache and /root/.npm/_logs for logs —
# both unwritable. Redirect both under /tmp (the only rw tmpfs).
export npm_config_cache="/tmp/.npm-cache"
export npm_config_logs_dir="/tmp/.npm-logs"
export npm_config_update_notifier=false
mkdir -p "$npm_config_cache" "$npm_config_logs_dir" "$APP_DIR"

# Copy the user's source into a writable location. -L follows symlinks
# (none expected, but harmless) and the trailing /. copies the contents,
# not the /app directory itself.
cp -RL /app/. "$APP_DIR"/

cd "$APP_DIR"

if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
elif [[ -f package.json ]]; then
  npm install --omit=dev --no-audit --no-fund
fi

# Make the base layer's pre-installed deps (zyndai, dotenv, zod, tsx)
# visible to ESM bare imports as a fallback by symlinking each missing
# package into $APP_DIR/node_modules. This only fills gaps — anything
# the user pinned in their own package.json wins.
mkdir -p "$APP_DIR/node_modules"
shopt -s nullglob
for pkg in /opt/zynd-base/node_modules/*; do
  name="$(basename "$pkg")"
  # Skip dotfiles like .bin / .package-lock.json.
  [[ "$name" == .* ]] && continue
  if [[ ! -e "$APP_DIR/node_modules/$name" ]]; then
    ln -s "$pkg" "$APP_DIR/node_modules/$name"
  fi
done
# Scoped packages (@types/foo, @scope/bar) live one level deeper.
for scope in /opt/zynd-base/node_modules/@*; do
  scope_name="$(basename "$scope")"
  mkdir -p "$APP_DIR/node_modules/$scope_name"
  for pkg in "$scope"/*; do
    name="$(basename "$pkg")"
    if [[ ! -e "$APP_DIR/node_modules/$scope_name/$name" ]]; then
      ln -s "$pkg" "$APP_DIR/node_modules/$scope_name/$name"
    fi
  done
done
shopt -u nullglob

# Worker-issued start command targets /app/<entry>.ts. Rewrite the
# leading /app/ to $APP_DIR/ so the entry resolves from the writable
# copy where node_modules now lives.
NEW_ARGS=()
for a in "$@"; do
  NEW_ARGS+=("${a/#\/app\//$APP_DIR/}")
done

exec "${NEW_ARGS[@]}"
