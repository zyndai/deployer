# zynd-deployer — Plan

Status: Draft · Date: 2026-04-18 · Scope: HTTP agents and services, v1

## 1. What we're building

A standalone web app + background worker that runs on a single VM and hosts user-uploaded Zynd agents/services as Docker containers, each reachable at a stable HTTPS URL. The deployer replaces ngrok for people who want a persistent hosted agent without owning infra.

**Core UX (the user's spec):**

1. Open the deployer page. No login.
2. Click **Deploy Agent** or **Deploy Service**.
3. Drag-drop the zynd project folder.
4. Drag-drop the identity `keypair.json`.
5. Click Deploy. Deployer allocates a slug, builds and starts the container, registers the route in Caddy, and hands back `https://<slug>.deployer.zynd.ai`.
6. On the dashboard: list of all deployments. Click one to see live status, public URL, container stats, and streaming logs from the backend.
7. Crash detection: worker watches docker events and records every container that exits non-zero; the crash (exit code + last log lines) shows up on the detail page.

## 2. Decisions already locked

| Decision | Value | Why |
|---|---|---|
| Auth | **None** | Deployer is open. Attribution comes from the agent's own developer_id on the registry. |
| Public hostname | `deployer.zynd.ai` (UI) and `*.deployer.zynd.ai` (deployments) | One wildcard cert, one zone. Caddy path-matches the bare host for UI, wildcard for tenant routes. |
| Deployable kinds | HTTP agents + HTTP services | Per the user's direction. MQTT/legacy are out of scope. |
| Registration model | Agent auto-updates itself on every start | Developer key never touches the deployer. User runs `zynd agent run` locally once to do the initial POST + developer_proof; after that, the container just PUTs updates with the agent keypair. |
| Redeploy flow | User deletes the deployment, runs locally once, uploads a fresh folder | Keeps the registry record current and sidesteps atomic-swap complexity in v1. |
| Stack | Next.js 15 (App Router) + TypeScript + Tailwind + Prisma + Postgres, worker is a sibling Node process | Matches the wider Zynd stack. |
| Key encryption at rest | `age` with a VM-local master key | Decrypted only when the container starts. |

## 3. The critical SDK change this depends on

`zyndai-agent` today has no clean way for a container to advertise a public HTTPS URL separate from where the webhook server binds. `webhook_host` is used both as the bind interface AND as the hostname that builds the advertised URL in `_build_entity_url`. The existing `webhook_url` field is a partial override but is confusingly named (sounds like a path, not a base URL), isn't read from env, and isn't passed by any of the example templates.

**Fix at the SDK level: introduce a dedicated `entity_url` field.** Naming it `entity_url` (not `public_url`, not `external_url`) matches the registry's actual field name end-to-end — config key, registry payload, and Agent Card all use the same word.

**Field semantics after the change:**

| Field | Purpose |
|---|---|
| `webhook_host` | TCP bind interface inside the process (`0.0.0.0` / `127.0.0.1`). Never appears in any public payload. |
| `webhook_port` | TCP bind port inside the process. |
| `entity_url` | Full public URL advertised to the registry and used to build the Agent Card at `/.well-known/zynd-agent.json`. Takes precedence over everything else. |
| `webhook_url` | Deprecated alias for `entity_url`. Kept for one release for backward compat, then removed. |

`_build_entity_url` precedence becomes: `entity_url` → `webhook_url` (with deprecation warning) → `http://{host}:{port}` derivation.

**Changes in `zyndai-agent`:**

1. `zyndai_agent/base.py` (`ZyndBaseConfig`): add `entity_url: Optional[str] = None`.
2. `zyndai_agent/config_manager.py` (`_build_entity_url`): check `entity_url` first.
3. `zynd_cli/templates/*.py.tpl` + `examples/http/**/*.py`: add one line that reads from env:
   ```python
   entity_url=os.environ.get("ZYND_ENTITY_URL", _config.get("entity_url")),
   ```
4. `zynd_cli/commands/_entity_base.py` subprocess spawn: forward `--entity-url` (if given) as `ZYND_ENTITY_URL` env var, so local `zynd agent run --entity-url …` stays symmetric with what the deployer does.

**Auto-update-on-start** (second small SDK change): after the webhook server is healthy, if the entity already exists on the registry, the SDK sends a single `PUT /v1/entities/{entity_id}` with the current `entity_url`. Idempotent no-op if nothing changed. This is what makes the deployer's "every start refreshes the registry" flow work without the deployer touching the registry directly.

Once both ship, the deployer never edits user code or config files beyond the `.env` rewrite. Containers self-update on every start.

If the patches slip, the fallback is for the deployer worker (outside the container) to sign and send `PUT /v1/entities/{id}` itself using the decrypted agent keypair. The Agent Card served by the container at `/.well-known/agent.json` would still show localhost in that fallback mode, but the registry record — which is what callers actually use for discovery — would be correct.

## 4. Architecture

```
  Browser (no login)                      VM: single box
  ──────────────────                      ───────────────
  Drag-drop folder ─► POST /api/deployments
  Drag-drop keypair    (Next.js API route)
                       ├─ validate upload
                       ├─ age-encrypt blob
                       ├─ insert Deployment{status:queued}
                       └─ return deployment id

  GET /api/deployments/:id/logs (SSE)  ◄─── streams rows from DeploymentLog

                                            Worker (systemd, Node)
                                            ──────────────────────
                                            loop:
                                              claim queued row (SELECT ... FOR UPDATE SKIP LOCKED)
                                              ├─ decrypt blob + unpack to /var/lib/zynd-deployer/work/<id>/
                                              ├─ allocate port (bind check on 127.0.0.1)
                                              ├─ rewrite .env  (add ZYND_*, keep user's API keys)
                                              ├─ rewrite agent.config.json  (registry_url, webhook_port=5000)
                                              ├─ docker run base-image + bind-mount workdir
                                              ├─ poll http://127.0.0.1:<port>/health
                                              ├─ Caddy admin API: add route <slug>.deployer.zynd.ai → 127.0.0.1:<port>
                                              ├─ status = running
                                              ├─ docker logs -f  ─► insert DeploymentLog rows
                                              └─ docker events  ─► on die/exit, record crash

                                            Caddy (systemd)
                                            ───────────────
                                            *.deployer.zynd.ai → 127.0.0.1:<port per slug>
                                            deployer.zynd.ai   → 127.0.0.1:3000 (Next.js)
                                            TLS via Cloudflare DNS-01 wildcard

                                            Container
                                            ─────────
                                            ENTRYPOINT: python {agent,service}.py
                                            ENV:
                                              ZYND_AGENT_KEYPAIR_PATH=/app/keypair.json
                                              ZYND_REGISTRY_URL=https://dns01.zynd.ai
                                              ZYND_WEBHOOK_PORT=5000
                                              ZYND_ENTITY_URL=https://<slug>.deployer.zynd.ai
                                            Port: 5000 inside, mapped to 127.0.0.1:<alloc> on host
                                            Network: bridge + egress allowlist
```

## 5. Upload contract

Client zips the project folder (jszip) and posts two files in one multipart form:

- `project.zip` — must contain exactly the zynd project folder at the root:
  - `{agent,service}.config.json`  (required)
  - `{agent,service}.py` (required)
  - `.env` (required if the agent uses framework API keys like OPENAI_API_KEY)
  - `requirements.txt` (optional; added to base image layer cache)
- `keypair.json` — the agent/service Ed25519 identity (public_key + private_key, base64)

**Validation (`src/lib/validator.ts`):**

- Exactly one of `agent.config.json` or `service.config.json` at root.
- Matching `.py` file (`agent.py` for agent, `service.py` for service).
- `keypair.json` parses, has `public_key` and `private_key` both base64.
- **Reject if the zip contains `developer.json` or `~/.zynd/developer/` path**. Developer keys must never be uploaded.
- No absolute paths, no symlinks, no files over 50MB, no zip bomb (decompress ratio cap).
- `requirements.txt`, if present, line count ≤ 200.
- Config JSON shape check: `name` required, slugifies cleanly, no duplicate slug in running deployments.

## 6. Deploy pipeline (worker state machine)

```
queued
  → unpacking         (decrypt, extract to workdir)
  → writing_config    (rewrite .env, rewrite *.config.json)
  → allocating_port   (lowest free port in 13000-14000)
  → building          (only if requirements.txt present; else skip)
  → starting          (docker run --name zynd-<id> -p 127.0.0.1:<port>:5000 ...)
  → health_checking   (GET /health, 30 retries @ 500ms)
  → registering_route (POST to Caddy admin API)
  → running           (terminal success state)

  any step can transition to:
  → failed            (errorMessage captured; container cleaned up)
  → stopped           (user clicked Stop)
  → crashed           (docker event: die with exit != 0)
```

### Config/env rewrite rules

**`.env` in the container workdir** gets re-written to merge:

- Every key from the user's uploaded `.env` (OPENAI_API_KEY, TAVILY_API_KEY, etc.)
- Plus injected:
  - `ZYND_AGENT_KEYPAIR_PATH=/app/keypair.json` (or `ZYND_SERVICE_KEYPAIR_PATH`)
  - `ZYND_REGISTRY_URL=https://dns01.zynd.ai`
  - `ZYND_WEBHOOK_PORT=5000`
  - `ZYND_ENTITY_URL=https://<slug>.deployer.zynd.ai`

**`agent.config.json` / `service.config.json`** is rewritten with:

- `webhook_port: 5000`
- `registry_url: "https://dns01.zynd.ai"`
- `keypair_path: "/app/keypair.json"`

Original fields (`name`, `category`, `tags`, `summary`, `entity_pricing`, `entity_index`) are preserved verbatim.

### Docker run flags (per container)

```
docker run -d
  --name zynd-<id>
  --restart unless-stopped
  -p 127.0.0.1:<alloc_port>:5000
  -v /var/lib/zynd-deployer/work/<id>:/app:ro
  -v /var/lib/zynd-deployer/keys/<id>/keypair.json:/app/keypair.json:ro
  --env-file /var/lib/zynd-deployer/work/<id>/.env.rendered
  --memory=512m --cpus=0.5
  --read-only --tmpfs /tmp
  --security-opt=no-new-privileges
  --userns=host-remap-default
  zynd-deployer/agent-base:latest
```

### Caddy route registration

On health pass, `POST` to Caddy admin API (`http://localhost:2019`):

```json
{
  "@id": "<deployment-id>",
  "match": [{"host": ["<slug>.deployer.zynd.ai"]}],
  "handle": [
    {"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:<port>"}]}
  ]
}
```

On stop/delete, `DELETE /id/<deployment-id>` clears the route.

## 7. Crash detection + log streaming

The worker opens one long-lived connection to `docker events` (via `dockerode`). For every `die`/`oom`/`kill` event on a `zynd-<id>` container, it:

1. Reads exit code from `docker inspect`.
2. Pulls the last 200 lines of `docker logs`.
3. Updates `Deployment.status = "crashed"`, `Deployment.errorMessage = "<exit code + summary>"`.
4. Inserts a sentinel `DeploymentLog { lineNo: ..., text: "[CRASH exit=N] <tail>" }`.

For live logs, the worker runs one `docker logs -f` tailer per running deployment. Each stdout/stderr line becomes a `DeploymentLog` row.

Frontend subscribes via **SSE** on `GET /api/deployments/:id/logs/stream`. The route opens a Postgres `LISTEN deployment_logs_<id>` (or simply polls `DeploymentLog` after the last-seen line number every 500ms — pick whichever is less fiddly during v1 impl). Initial payload is the last 500 lines; then live lines flow as they come in.

## 8. Data model (Prisma)

No User table. Developer attribution is whatever is on the agent keypair.

```prisma
model Deployment {
  id            String   @id @default(cuid())
  name          String                          // user-supplied, from config.name
  slug          String   @unique                // slugify(name) + short random suffix
  entityType    String                          // "agent" | "service"
  entityId      String?                         // filled in after first successful start
  registryUrl   String                          // snapshotted (default https://dns01.zynd.ai)

  status        String                          // queued|unpacking|starting|running|failed|stopped|crashed
  errorMessage  String?

  blobPath      String                          // /var/lib/zynd-deployer/blobs/<id>.age
  keyPath       String                          // /var/lib/zynd-deployer/keys/<id>/keypair.json.age

  port          Int?     @unique                // allocated host port on 127.0.0.1
  containerId   String?
  hostUrl       String?                         // https://<slug>.deployer.zynd.ai
  publicKeyB64  String?                         // derived from keypair, shown in UI

  lastExitCode  Int?                            // non-null after a crash or clean exit
  lastCrashAt   DateTime?

  createdAt     DateTime @default(now())
  startedAt     DateTime?
  stoppedAt     DateTime?

  logs          DeploymentLog[]
}

model DeploymentLog {
  id           BigInt    @id @default(autoincrement())
  deploymentId String
  lineNo       Int
  text         String    @db.Text
  stream       String                          // "stdout" | "stderr" | "system"
  ts           DateTime  @default(now())

  deployment   Deployment @relation(fields: [deploymentId], references: [id], onDelete: Cascade)

  @@index([deploymentId, lineNo])
}

model PortAllocation {
  port     Int     @id                          // guard against races even without User
  deploymentId String @unique
  takenAt  DateTime @default(now())
}
```

## 9. API surface

```
POST   /api/deployments            # multipart: project.zip + keypair.json → {id, slug, status}
GET    /api/deployments            # list (with status, hostUrl, createdAt)
GET    /api/deployments/:id        # detail (includes port, containerId, lastExitCode)
DELETE /api/deployments/:id        # stop + remove route + mark stopped
GET    /api/deployments/:id/logs   # last N log lines (paginated)
GET    /api/deployments/:id/logs/stream   # SSE live tail
GET    /api/deployments/:id/stats  # docker stats snapshot (cpu%, mem, net) — v2 (optional in v1)
```

Worker does not expose HTTP; it only talks to Postgres and the Docker socket.

## 10. Repo layout

```
zynd-deployer/
├── PLAN.md                       (this file)
├── README.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── next.config.ts
├── .env.example
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app/
│   │   ├── page.tsx              # deployments list
│   │   ├── deploy/page.tsx       # drag-drop UI (Agent / Service tabs)
│   │   ├── d/[id]/page.tsx       # detail + live logs
│   │   ├── layout.tsx
│   │   └── api/
│   │       └── deployments/
│   │           ├── route.ts                       # POST list + create
│   │           └── [id]/
│   │               ├── route.ts                   # GET detail, DELETE stop
│   │               └── logs/
│   │                   ├── route.ts               # GET paginated
│   │                   └── stream/route.ts        # SSE tail
│   ├── components/
│   │   ├── DeployAgentCard.tsx
│   │   ├── DeployServiceCard.tsx
│   │   ├── DropZone.tsx
│   │   ├── DeploymentList.tsx
│   │   ├── LogStream.tsx
│   │   └── StatusBadge.tsx
│   └── lib/
│       ├── db.ts                 # Prisma singleton
│       ├── crypto.ts             # age wrapper
│       ├── validator.ts          # zip/keypair validation
│       ├── slug.ts
│       └── types.ts
├── worker/
│   ├── main.ts                   # poll loop + crash watcher
│   ├── lifecycle.ts              # state-machine transitions
│   ├── docker.ts                 # dockerode wrapper
│   ├── caddy.ts                  # admin API client
│   ├── ports.ts                  # allocator
│   ├── logs.ts                   # tailer
│   └── crash.ts                  # events + exit-code capture
├── images/
│   ├── Dockerfile.agent-base     # python:3.12-slim + zyndai-agent + langchain stack
│   └── Dockerfile.service-base   # python:3.12-slim + zyndai-agent (minimal)
└── infra/
    ├── install.sh                # VM bootstrap: docker, postgres, caddy, systemd units
    ├── systemd/
    │   ├── zynd-deployer-web.service
    │   └── zynd-deployer-worker.service
    └── Caddyfile                 # base config (admin API on :2019, DNS-01 wildcard)
```

## 11. Base images

Two small Dockerfiles, rebuilt manually by the operator when `zyndai-agent` is bumped.

**`images/Dockerfile.agent-base`**

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir \
      zyndai-agent \
      langchain langchain-openai langchain-community langchain-classic \
      pydantic-ai crewai langgraph \
      python-dotenv requests
WORKDIR /app
EXPOSE 5000
# ENTRYPOINT set at `docker run` time by worker:
#   python /app/agent.py
```

**`images/Dockerfile.service-base`** — same but without the heavy agent frameworks; just `zyndai-agent` + `fastapi` + `python-dotenv`.

If the user's zip has `requirements.txt`, the worker does a short `pip install -r requirements.txt --target /app/site-packages` step inside the container at `docker run` time (via a small `entrypoint.sh` baked into the base) and prepends that to `PYTHONPATH`. This keeps container start under 15s for the common case where users only need langchain (already in base).

## 12. Security

- **Agent private key**: uploaded, immediately `age`-encrypted to `/var/lib/zynd-deployer/keys/<id>/keypair.json.age`, decrypted to a tmpfs path only for the `docker run`. The decrypted file is bind-mounted into the container and removed from the host when the container stops.
- **Developer private key**: never uploaded. Validator rejects any upload containing `developer.json` anywhere in the zip, and scans `.env` for the string `AGENT_*_SEED`-style developer seed names out of paranoia (reject + show an error).
- **Container isolation**: `--read-only`, `no-new-privileges`, `userns-remap`, CPU/mem caps. Egress is allowed (agents need to call OpenAI etc.) but bound to `127.0.0.1:<port>` on the host side — never directly exposed to the public internet. Only Caddy can reach it.
- **Storage**: Postgres on the same VM. Blobs and encrypted keys on local disk (`/var/lib/zynd-deployer/`). Nightly backup via cron is out of scope for v1.
- **Operator trust**: the operator with VM root can decrypt keys. Disclosed in the UI on upload ("Deployer operator can read your agent key; do not upload mainnet production keys").

## 13. Phases

### v1 — MVP (what we ship first)

1. Repo scaffold + `pnpm create next-app`, Tailwind, Prisma, postgres in docker-compose for dev.
2. `infra/install.sh` that bootstraps a fresh Ubuntu 24.04 VM: installs Docker, Postgres, Caddy, age, creates systemd units, pulls base images.
3. Prisma migrations.
4. `POST /api/deployments` (validate + encrypt + insert).
5. Worker state machine through `running`.
6. Caddy admin API integration (wildcard DNS-01 presumed already configured via `Caddyfile`).
7. Frontend: drag-drop page (Agent / Service tabs), list page, detail page with live SSE logs.
8. Crash detection via `docker events`.
9. End-to-end smoke: deploy `examples/http/swapnil-persona/` and confirm it registers on dns01.zynd.ai with the deployer URL.

### v2

- Stop / restart / redeploy buttons in the UI (v1 only has stop-and-new).
- `docker stats` polling → time-series chart on detail page.
- GC: prune stopped deployments after 7 days.
- Rate limit: max 50 active deployments per VM.
- Multi-VM scheduling (Postgres-backed queue, workers on each host).
- Image signing for base images.
- Pre-signed developer_proof file so users can skip the local `zynd agent run` step.

### v3

- Egress firewall per deployment (explicit allowlist).
- Zero-knowledge mode: client-side age encrypt before upload, operator cannot read keys.

## 14. Open questions to resolve during implementation

1. **SDK patch timing.** The plan assumes `zyndai-agent` will ship the new `entity_url` field (+ `ZYND_ENTITY_URL` env support) + auto-update-on-start before v1 goes live. If it slips, we fall back to the worker-side registry update described in §3.
2. **Heartbeat URL.** Heartbeats go over WebSocket to the registry; the agent needs its `entity_url` correct in its outbound heartbeats. Confirm the SDK patch covers both the Agent Card and the heartbeat payload.
3. **Slug collisions with redeploy.** Current plan is "user deletes old deployment first." Need to confirm: when the old deployment row is deleted, should the slug be reusable immediately, or soft-delete for 24h to avoid DNS caching surprises? Suggestion: soft-delete with 5-minute cooldown.
4. **Streaming logs at scale.** Polling `DeploymentLog` via SSE is fine for dozens of deployments; if we hit hundreds, switch to Postgres `LISTEN/NOTIFY` or a Redis pubsub channel. Flagged in code as a future swap.
5. **Base-image choice per framework.** Single `agent-base` with langchain + crewai + pydantic-ai pre-installed is heavy (~1.5GB). Alternative: 4 lean images, user picks at deploy time. Recommendation for v1: one fat image, optimize in v2.

## 15. What "done for v1" looks like

A user at `deployer.zynd.ai` drops in the contents of `zyndai-agent/examples/http/swapnil-persona/` plus a matching `keypair.json`, clicks Deploy, waits ~20 seconds, gets `https://swapnil-persona.deployer.zynd.ai` that responds to `/health`, shows up on `dns01.zynd.ai` with the new URL, and streams logs into the detail page. If the container crashes the status flips to `crashed` and the last log tail is visible.
