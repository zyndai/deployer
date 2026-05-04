// State-machine that drives a single deployment from `queued` to
// `running`. Each step is its own function so we can log transitions
// cleanly. All failures are caught at the top and flip the row to
// `failed` with a human-readable errorMessage.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

import { prisma } from "@/lib/db";
import { decryptFile, decryptToFile } from "@/lib/crypto";
import { config, paths } from "@/lib/config";
import { ACTIVE_STATUSES } from "@/lib/types";
import type { DeploymentStatus, EntityType, Runtime } from "@/lib/types";
import { pythonWorkerRuntime } from "./runtimes/python";
import { nodeWorkerRuntime } from "./runtimes/node";

import { allocatePort, releasePort } from "./ports";
import { runContainer, stopAndRemove } from "./docker";
import { addRoute, removeRoute } from "./caddy";
import { appendSystemLog, startTailer } from "./logs";

const HEALTH_INTERVAL_MS = Math.max(50, config.bootHealthIntervalMs);
const HEALTH_ATTEMPTS = Math.max(
  1,
  Math.ceil(config.bootHealthTimeoutMs / HEALTH_INTERVAL_MS)
);

/**
 * Look up the worker-side runtime adapter for a deployment row.
 * Falls back to python so existing rows without the column still work.
 */
function workerRuntime(runtime: string) {
  if ((runtime as Runtime) === "node") return nodeWorkerRuntime;
  return pythonWorkerRuntime;
}

/**
 * The URL the agent/service should advertise to the registry and the
 * URL the deployer's UI should link to. In production, that's the
 * Caddy-fronted `https://<slug>.<wildcardDomain>`. In local dev with
 * DEPLOYER_SKIP_CADDY=true, there's no reverse proxy and no TLS, so
 * we hand out the raw `http://localhost:<host-port>` instead — which
 * is actually reachable.
 */
function buildHostUrl(slug: string, port: number): string {
  if (config.skipCaddy) return `http://localhost:${port}`;
  return `https://${slug}.${config.wildcardDomain}`;
}

async function setStatus(id: string, status: DeploymentStatus, patch: Record<string, unknown> = {}) {
  console.log(`[lifecycle] ${id} → ${status}`);
  await prisma.deployment.update({
    where: { id },
    data: { status, ...patch },
  });
}

async function failDeployment(
  id: string,
  msg: string,
  cleanup?: () => Promise<void>
): Promise<void> {
  console.error(`[lifecycle] ${id} FAILED: ${msg}`);
  await appendSystemLog(id, `[FAILED] ${msg}`).catch(() => undefined);
  await prisma.deployment.update({
    where: { id },
    data: {
      status: "failed",
      errorMessage: msg.slice(0, 500),
      port: null,
      containerId: null,
    },
  });
  if (cleanup) await cleanup().catch(() => undefined);
}

export async function drive(deploymentId: string): Promise<void> {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!dep) return;
  if (!ACTIVE_STATUSES.includes(dep.status as (typeof ACTIVE_STATUSES)[number])) {
    return;
  }

  const workdir = join(paths.work, deploymentId);
  const keyWorkPath = join(paths.work, deploymentId, "keypair.json");
  const envRenderedPath = join(workdir, ".env.rendered");
  let port: number | null = null;
  let containerId: string | null = null;
  let routeAdded = false;

  const cleanup = async () => {
    if (containerId) await stopAndRemove(containerId);
    if (routeAdded) await removeRoute(deploymentId).catch(() => undefined);
    if (port !== null) await releasePort(deploymentId);
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // --- 1. unpack ----------------------------------------------------

    await setStatus(deploymentId, "unpacking");
    await appendSystemLog(deploymentId, "[worker] decrypting upload");

    await mkdir(workdir, { recursive: true });
    const zipBuf = await decryptFile(dep.blobPath);
    const zip = await JSZip.loadAsync(zipBuf);

    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const dst = join(workdir, entry.name);
      await mkdir(join(dst, ".."), { recursive: true });
      const bytes = await entry.async("nodebuffer");
      await writeFile(dst, bytes);
    }

    await decryptToFile(dep.keyPath, keyWorkPath);

    // --- 2. allocate port --------------------------------------------
    //
    // Port allocation moved ahead of config rendering: the rendered
    // ZYND_ENTITY_URL needs the host port in skip-caddy mode.

    await setStatus(deploymentId, "allocating_port");
    port = await allocatePort(deploymentId);
    await appendSystemLog(deploymentId, `[worker] allocated host port ${port}`);

    // --- 3. write config ---------------------------------------------

    await setStatus(deploymentId, "writing_config");
    await writeRenderedConfig(
      deploymentId,
      dep.slug,
      dep.entityType as EntityType,
      workdir,
      envRenderedPath,
      port
    );

    // --- 4. start container (we skip explicit build in v1) -----------

    await setStatus(deploymentId, "starting");
    const rt = workerRuntime(dep.runtime ?? "python");
    const entityType = dep.entityType as EntityType;
    // User-picked image (operator-built flavor like agent-playwright)
    // wins over the per-runtime default. Null falls back to the base.
    const image = dep.image ?? rt.baseImage(entityType);
    containerId = await runContainer({
      deploymentId,
      workdir,
      keyHostPath: keyWorkPath,
      entityType,
      hostPort: port,
      envFilePath: envRenderedPath,
      image,
      cmd: rt.startCmd(entityType),
    });
    await appendSystemLog(deploymentId, `[worker] using image ${image}`);
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { port, containerId, startedAt: new Date() },
    });
    await appendSystemLog(
      deploymentId,
      `[worker] started container ${containerId.slice(0, 12)}`
    );

    // Start tailing logs now so users see the container boot output
    // while we wait for /health.
    await startTailer(deploymentId, containerId).catch(() => undefined);

    // --- 5. health check ---------------------------------------------

    await setStatus(deploymentId, "health_checking");
    const hcStart = Date.now();
    const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`);
    console.log(
      `[lifecycle] ${deploymentId} health check ${healthy ? "passed" : "failed"} ` +
        `in ${Date.now() - hcStart}ms on port ${port}`
    );
    if (!healthy) {
      throw new Error(`Container did not become healthy within ${HEALTH_ATTEMPTS * HEALTH_INTERVAL_MS}ms`);
    }

    // --- 6. register Caddy route -------------------------------------

    await setStatus(deploymentId, "registering_route");
    await addRoute(deploymentId, dep.slug, port);
    routeAdded = true;

    // --- 7. running --------------------------------------------------

    const hostUrl = buildHostUrl(dep.slug, port);
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: "running",
        hostUrl,
      },
    });
    await appendSystemLog(deploymentId, `[worker] live at ${hostUrl}`);

    // Best-effort: pull entityId from the agent's well-known descriptor.
    // The agent owns this — the deployer doesn't know the registry id
    // until the agent itself reports it. Failures are non-fatal.
    backfillEntityId(deploymentId, port).catch((e) =>
      console.warn(`[lifecycle] entityId backfill error: ${(e as Error).message}`)
    );
  } catch (e) {
    await failDeployment(deploymentId, (e as Error).message, cleanup);
  }
}

/**
 * Merge the uploaded .env with the deployer-managed vars and rewrite
 * the *.config.json so webhook_port / keypair_path line up with what
 * the container sees.
 *
 * This is the one place where the deployer touches user code, and it's
 * deliberately non-destructive — we write `.env.rendered` alongside the
 * original `.env` rather than overwriting it.
 */
async function writeRenderedConfig(
  deploymentId: string,
  slug: string,
  entityType: EntityType,
  workdir: string,
  envRenderedPath: string,
  port: number
): Promise<void> {
  const hostUrl = buildHostUrl(slug, port);
  const keypairEnv =
    entityType === "service" ? "ZYND_SERVICE_KEYPAIR_PATH" : "ZYND_AGENT_KEYPAIR_PATH";

  // Start with the user's own env vars, if any.
  const merged = new Map<string, string>();
  try {
    const raw = await readFile(join(workdir, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (k) merged.set(k, v);
    }
  } catch {
    // no .env — fine
  }

  // Deployer-owned values always win.
  merged.set(keypairEnv, "/app/keypair.json");
  merged.set("ZYND_REGISTRY_URL", config.registryUrl);
  // Both names: ZYND_SERVER_PORT is the post-A2A name; ZYND_WEBHOOK_PORT
  // kept for back-compat with pre-A2A SDK versions still in the wild.
  merged.set("ZYND_SERVER_PORT", "5000");
  merged.set("ZYND_WEBHOOK_PORT", "5000");
  merged.set("ZYND_ENTITY_URL", hostUrl);

  const lines = Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`);
  await writeFile(envRenderedPath, lines.join("\n") + "\n", { mode: 0o600 });

  // Rewrite the config JSON so the process inside the container reads
  // the same settings the SDK advertises.
  const configFile =
    entityType === "service" ? "service.config.json" : "agent.config.json";
  const configPath = join(workdir, configFile);
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    // Pin both the post-A2A field name (server_port) and the legacy
    // alias (webhook_port). The SDK prefers server_port; without this
    // a project zipped with `server_port: 5002` would bind inside the
    // container to 5002 — but the container only exposes 5000 — and
    // the deployer's healthcheck would time out.
    raw.server_port = 5000;
    raw.webhook_port = 5000;
    raw.server_host = "0.0.0.0";
    raw.registry_url = config.registryUrl;
    raw.keypair_path = "/app/keypair.json";
    await writeFile(configPath, JSON.stringify(raw, null, 2));
  } catch (e) {
    throw new Error(`Failed to rewrite ${configFile}: ${(e as Error).message}`);
  }

  void deploymentId;
}

async function backfillEntityId(deploymentId: string, port: number): Promise<void> {
  // Try the post-A2A path first, fall back to the pre-A2A path so older
  // images still work. The SDK serves agent-card.json now; agent.json is
  // kept around in some old deployments but no longer required.
  const candidates = [
    `http://127.0.0.1:${port}/.well-known/agent-card.json`,
    `http://127.0.0.1:${port}/.well-known/agent.json`,
  ];
  let res: Response | undefined;
  let lastErr: string | undefined;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        res = r;
        break;
      }
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  if (!res) {
    console.log(
      `[lifecycle] ${deploymentId} entityId backfill skipped: ${lastErr ?? "no card endpoint"}`
    );
    return;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return;
  }
  const entityId = extractEntityId(body);
  if (!entityId) return;

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { entityId },
  });
  await appendSystemLog(deploymentId, `[worker] entityId=${entityId}`).catch(
    () => undefined
  );
}

function extractEntityId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  for (const key of ["entity_id", "entityId", "id"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

async function waitForHealth(url: string): Promise<boolean> {
  for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.status === 200) return true;
    } catch {
      // connection refused / timeout — normal during boot
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return false;
}
