# zynd-deployer

Host user-uploaded Zynd agents and services on a single VM with stable HTTPS URLs.

This repo is the control plane + worker that replaces ngrok for anyone who wants a
persistent hosted Zynd agent without owning infra. See [PLAN.md](./PLAN.md) for the
full design rationale.

## Quick start (local dev)

Requires Node 20+, Docker, Postgres 15+, and [age](https://github.com/FiloSottile/age) on the
host.

```bash
pnpm install
cp .env.example .env
# point DATABASE_URL at a local postgres, then:
age-keygen -o ./master.age
export AGE_IDENTITY_PATH="$PWD/master.age"
pnpm prisma:migrate:dev
pnpm dev          # Next.js on :3000
pnpm worker:dev   # worker polling loop
```

Open <http://localhost:3000>, drag-drop a Zynd project folder + its `keypair.json`,
and click Deploy. On prod the app lives at <https://deployer.zynd.ai> and
deployments get `https://<slug>.deployer.zynd.ai`.

## Production

One-shot bootstrap on a fresh Ubuntu 24.04 VM:

```bash
sudo bash infra/install.sh
```

That installs Docker, Postgres, Caddy, age, builds the base images, writes the
systemd units for the web service and worker, and configures the wildcard DNS-01
cert in Caddy. After that the operator just runs `systemctl enable --now
zynd-deployer-web zynd-deployer-worker`.

## Layout

```
zynd-deployer/
├── src/              # Next.js 15 app (UI + API routes)
├── worker/           # Background process: docker + caddy lifecycle
├── prisma/           # Database schema + migrations
├── images/           # Base Dockerfiles for agent and service containers
├── infra/            # VM bootstrap script, systemd units, Caddyfile
└── PLAN.md           # Design doc
```

## Uploads the deployer accepts

- `project.zip` containing either an `agent.config.json` + `agent.py`, or a
  `service.config.json` + `service.py`, at the root.
- `keypair.json` — the Ed25519 identity for the agent/service.

The developer key stays on the user's laptop. The deployer refuses uploads that
include a `developer.json` file.

See [PLAN.md §5](./PLAN.md) for the full validation contract.
