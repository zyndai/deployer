#!/usr/bin/env bash
# zynd-deployer one-shot bootstrap for a fresh Ubuntu 24.04 VM.
#
#   sudo bash infra/install.sh
#
# Idempotent — safe to re-run. After this finishes:
#   - Docker, Postgres 16, Caddy, age, Node 20, pnpm are installed
#   - A 'zynd' user owns /opt/zynd-deployer and /var/lib/zynd-deployer
#   - Base images are built
#   - Systemd units are installed (but not started — operator starts them)
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY_ROOT=/opt/zynd-deployer
DATA_ROOT=/var/lib/zynd-deployer
ETC_DIR=/etc/zynd-deployer
ZYND_USER=zynd

if [[ $EUID -ne 0 ]]; then
  echo "Run me as root (sudo bash infra/install.sh)" >&2
  exit 1
fi

echo "==> Installing system packages"
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg lsb-release \
  postgresql postgresql-contrib \
  age \
  build-essential

# ---- Docker -----------------------------------------------------------------
if ! command -v docker >/dev/null; then
  echo "==> Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
fi

# ---- Caddy ------------------------------------------------------------------
if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update
  apt-get install -y caddy
fi

# Cloudflare DNS-01 plugin for wildcard cert.
caddy add-package github.com/caddy-dns/cloudflare || true

# ---- Node 20 ----------------------------------------------------------------
if ! node -v 2>/dev/null | grep -q '^v20'; then
  echo "==> Installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# ---- User + dirs ------------------------------------------------------------
echo "==> Creating zynd user + data dirs"
id -u "$ZYND_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$ZYND_USER"
usermod -aG docker "$ZYND_USER"

install -d -o "$ZYND_USER" -g "$ZYND_USER" -m 0750 "$DEPLOY_ROOT" "$DATA_ROOT" \
  "$DATA_ROOT/blobs" "$DATA_ROOT/keys" "$DATA_ROOT/work"
install -d -m 0755 "$ETC_DIR"

# ---- Age master key ---------------------------------------------------------
if [[ ! -f "$DATA_ROOT/master.age" ]]; then
  echo "==> Generating age master key at $DATA_ROOT/master.age"
  sudo -u "$ZYND_USER" age-keygen -o "$DATA_ROOT/master.age"
  chmod 0600 "$DATA_ROOT/master.age"
fi

# ---- Postgres database ------------------------------------------------------
echo "==> Ensuring postgres role + database"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zynd') THEN
    CREATE ROLE zynd LOGIN PASSWORD 'zynd';
  END IF;
END \$\$;
SQL
sudo -u postgres createdb -O zynd zynd_deployer 2>/dev/null || true

# ---- App install ------------------------------------------------------------
echo "==> Copying app to $DEPLOY_ROOT"
rsync -a --delete --exclude .git --exclude node_modules --exclude .next "$REPO_ROOT/" "$DEPLOY_ROOT/"
chown -R "$ZYND_USER:$ZYND_USER" "$DEPLOY_ROOT"

cd "$DEPLOY_ROOT"
sudo -u "$ZYND_USER" npm install --no-audit --no-fund
sudo -u "$ZYND_USER" npx prisma generate
sudo -u "$ZYND_USER" npx prisma migrate deploy
sudo -u "$ZYND_USER" npm run build

# ---- Systemd env files ------------------------------------------------------
if [[ ! -f "$ETC_DIR/web.env" ]]; then
  cat >"$ETC_DIR/web.env" <<EOF
DATABASE_URL=postgresql://zynd:zynd@localhost:5432/zynd_deployer?schema=public
NODE_ENV=production
HOSTNAME=127.0.0.1
PORT=3000
DEPLOYER_DATA_ROOT=$DATA_ROOT
AGE_IDENTITY_PATH=$DATA_ROOT/master.age
DEPLOYER_WILDCARD_DOMAIN=deployer.zynd.ai
ZYND_REGISTRY_URL=https://dns01.zynd.ai
CADDY_ADMIN_URL=http://127.0.0.1:2019
AGENT_BASE_IMAGE=zynd-deployer/agent-base:latest
SERVICE_BASE_IMAGE=zynd-deployer/service-base:latest
EOF
  chmod 0640 "$ETC_DIR/web.env"
fi

if [[ ! -f "$ETC_DIR/worker.env" ]]; then
  cp "$ETC_DIR/web.env" "$ETC_DIR/worker.env"
fi

# ---- Base images ------------------------------------------------------------
echo "==> Building base container images"
docker build -f "$DEPLOY_ROOT/images/Dockerfile.agent-base" \
  -t zynd-deployer/agent-base:latest "$DEPLOY_ROOT"
docker build -f "$DEPLOY_ROOT/images/Dockerfile.service-base" \
  -t zynd-deployer/service-base:latest "$DEPLOY_ROOT"

# ---- Systemd units ----------------------------------------------------------
install -m 0644 "$DEPLOY_ROOT/infra/systemd/zynd-deployer-web.service"    /etc/systemd/system/
install -m 0644 "$DEPLOY_ROOT/infra/systemd/zynd-deployer-worker.service" /etc/systemd/system/
install -m 0644 "$DEPLOY_ROOT/infra/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload

echo ""
echo "==> Done. To finish:"
echo "   1. Put CLOUDFLARE_API_TOKEN=... in /etc/default/caddy"
echo "   2. sudo systemctl enable --now caddy"
echo "   3. sudo systemctl enable --now zynd-deployer-web zynd-deployer-worker"
echo ""
echo "Web UI:  https://deployer.zynd.ai"
echo "Data:    $DATA_ROOT"
echo "Deploy:  $DEPLOY_ROOT"
