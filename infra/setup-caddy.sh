#!/usr/bin/env bash
# setup-caddy.sh — idempotent Caddy install + HTTPS config for zynd-deployer.
#
# Assumptions:
#   - Ubuntu 22.04+ / Debian 12+
#   - Run on the target VM (as a sudoer)
#   - Namecheap DNS already has:
#       A  deployer.zynd.ai    -> <this VM IP>
#       A  *.deployer.zynd.ai  -> <this VM IP>
#   - No Cloudflare, no DNS-API, no certbot. Caddy handles ACME via HTTP-01
#     natively for the apex. Tenant subdomains use on-demand TLS (cert
#     issued on first HTTPS hit per slug) so no wildcard cert is needed.
#   - Worker mutates routes via admin API at 127.0.0.1:2019.
#
# Re-running is safe: apt install is idempotent, Caddyfile is overwritten,
# service is reloaded (not restarted) so existing routes survive.

set -euo pipefail

DOMAIN="${DOMAIN:-deployer.zynd.ai}"
EMAIL="${EMAIL:-admin@zynd.ai}"
NEXT_UPSTREAM="${NEXT_UPSTREAM:-127.0.0.1:3000}"
CADDYFILE="/etc/caddy/Caddyfile"

log() { printf '\033[1;34m[setup-caddy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[setup-caddy]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo)."

# --- 1. Install Caddy (official apt repo) ----------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy from official apt repo…"
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  log "Caddy already installed: $(caddy version)"
fi

# --- 2. Stop anything holding :80 / :443 -----------------------------------
for svc in nginx apache2 httpd; do
  if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
    log "Disabling conflicting service: $svc"
    systemctl disable --now "$svc" || true
  fi
done

# --- 3. Write Caddyfile ----------------------------------------------------
log "Writing $CADDYFILE"
cat > "$CADDYFILE" <<EOF
{
    admin 127.0.0.1:2019
    email $EMAIL
    servers {
        trusted_proxies static 127.0.0.1/32
    }
    on_demand_tls {
        # The worker (or a tiny app endpoint) must answer 200 for hosts
        # that are valid tenants, anything else non-2xx. Without this,
        # strangers could force LE cert issuance for random subdomains.
        ask http://$NEXT_UPSTREAM/api/caddy/ask
    }
}

# --- UI ------------------------------------------------------------------
$DOMAIN {
    encode gzip
    reverse_proxy $NEXT_UPSTREAM
}

# --- Tenant wildcard -----------------------------------------------------
# Dynamic routes posted by the worker land in this server. on_demand TLS
# means Caddy issues a cert per slug via HTTP-01 on first HTTPS hit.
*.$DOMAIN {
    tls {
        on_demand
    }
    # Default handler. Worker overrides per-slug via admin API with a
    # reverse_proxy to 127.0.0.1:<hostPort>.
    respond "unknown tenant" 404
}
EOF

# --- 4. Validate ------------------------------------------------------------
log "Validating Caddyfile…"
caddy validate --config "$CADDYFILE"

# --- 5. Firewall ------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  log "Opening UFW ports 80, 443"
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

# --- 6. Enable + reload -----------------------------------------------------
log "Enabling + reloading caddy.service"
systemctl enable caddy >/dev/null 2>&1 || true
if systemctl is-active --quiet caddy; then
  systemctl reload caddy
else
  systemctl start caddy
fi

sleep 2
if ! systemctl is-active --quiet caddy; then
  journalctl -u caddy -n 40 --no-pager
  die "caddy.service failed to start — see log above"
fi

# --- 7. Smoke test ----------------------------------------------------------
log "Caddy status: $(systemctl is-active caddy)"
log "Admin API: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:2019/config/ || echo 'unreachable')"
log "Server names: $(curl -s http://127.0.0.1:2019/config/apps/http/servers/ | head -c 200)"

cat <<EOF

Done.

Next steps:
  1. Add '/api/caddy/ask' endpoint to Next.js that returns:
       200  if ?domain=<slug>.$DOMAIN exists as a running deployment
       404  otherwise
     Caddy calls it once per new subdomain before issuing a cert.
  2. Confirm DNS propagation:
       dig +short $DOMAIN
       dig +short foo.$DOMAIN
  3. Confirm UI is live:
       curl -I https://$DOMAIN
  4. Update .env if worker uses a custom server name:
       CADDY_SERVER_NAME=srv0    # check with:
       curl -s http://127.0.0.1:2019/config/apps/http/servers/ | jq 'keys'

Tenant deploys will get their cert automatically on first HTTPS hit
(~3–5 sec pause on cold subdomain). LE rate limit: 50 new certs / week
per registered domain — the /ask gate protects you from abuse hitting it.
EOF
