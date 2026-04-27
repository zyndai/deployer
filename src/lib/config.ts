// Central env lookup. Fail fast at boot if anything critical is missing,
// but only in the node runtime — the browser bundle should never touch
// this file.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be numeric, got: ${raw}`);
  }
  return n;
}

export const config = {
  dataRoot: optional("DEPLOYER_DATA_ROOT", "/var/lib/zynd-deployer"),
  wildcardDomain: optional("DEPLOYER_WILDCARD_DOMAIN", "deployer.zynd.ai"),
  registryUrl: optional("ZYND_REGISTRY_URL", "https://dns01.zynd.ai"),
  caddyAdminUrl: optional("CADDY_ADMIN_URL", "http://127.0.0.1:2019"),
  caddyServerName: optional("CADDY_SERVER_NAME", "srv0"),
  dockerSocket: optional("DOCKER_SOCKET", "/var/run/docker.sock"),
  ageIdentityPath: optional(
    "AGE_IDENTITY_PATH",
    "/var/lib/zynd-deployer/master.age"
  ),
  agentBaseImage: optional(
    "AGENT_BASE_IMAGE",
    "zynd-deployer/agent-base:latest"
  ),
  serviceBaseImage: optional(
    "SERVICE_BASE_IMAGE",
    "zynd-deployer/service-base:latest"
  ),
  portMin: numberEnv("DEPLOYER_PORT_MIN", 13000),
  portMax: numberEnv("DEPLOYER_PORT_MAX", 14000),
  maxActive: numberEnv("DEPLOYER_MAX_ACTIVE", 50),
  containerMemoryMb: numberEnv("DEPLOYER_CONTAINER_MEM_MB", 1536),
  containerCpuMillis: numberEnv("DEPLOYER_CONTAINER_CPU_MILLIS", 1000),

  // How long to wait for a freshly started container's /health to
  // return 200 before declaring the deployment FAILED. JS deploys run
  // `npm ci` in their entrypoint (writing into the /tmp tmpfs) before
  // the user code can bind a port — that alone can take 30–60s on
  // a cold cache. Default is 120s.
  bootHealthTimeoutMs: numberEnv("DEPLOYER_BOOT_HEALTH_TIMEOUT_MS", 120_000),
  bootHealthIntervalMs: numberEnv("DEPLOYER_BOOT_HEALTH_INTERVAL_MS", 500),

  // Size of the writable /tmp tmpfs mounted into each deployment
  // container. The container rootfs is read-only (see worker/docker.ts)
  // so this is also where npm/pip caches and the user's installed
  // node_modules live. node_modules for a typical TS agent runs
  // 150–400MB, so 512MB is a safer default than the original 64MB.
  // Counts against the container's memory limit.
  containerTmpfsMb: numberEnv("DEPLOYER_CONTAINER_TMPFS_MB", 512),

  // How long to keep per-line container logs in DeploymentLog before
  // the retention loop deletes them. System lines (the [CRASH] /
  // [FAILED] summaries the crash watcher writes) are kept longer so
  // the UI can still show a useful post-mortem on a 2-week-old dead
  // deployment. Set either to 0 to disable pruning.
  logRetentionDays: numberEnv("DEPLOYER_LOG_RETENTION_DAYS", 7),
  systemLogRetentionDays: numberEnv("DEPLOYER_SYSTEM_LOG_RETENTION_DAYS", 30),
  metricRetentionDays: numberEnv("DEPLOYER_METRIC_RETENTION_DAYS", 3),
  // How often the retention loop runs (in minutes). One run scans
  // and deletes in batches of 10k so we don't lock the table.
  retentionIntervalMinutes: numberEnv("DEPLOYER_RETENTION_INTERVAL_MIN", 60),

  // CPU / memory sampler for running containers. 30s gives ~17k
  // rows per deployment per week at the default 3-day retention.
  metricsIntervalSeconds: numberEnv("DEPLOYER_METRICS_INTERVAL_SEC", 30),

  // Periodic /health probe for running containers. Catches hangs
  // where the process is alive (and therefore invisible to the crash
  // watcher) but no longer serving requests. Three consecutive
  // failures move the deployment from `running` to `unhealthy` and
  // append a [UNHEALTHY] line to the system log.
  healthProbeIntervalSeconds: numberEnv("DEPLOYER_HEALTH_INTERVAL_SEC", 60),
  healthProbeTimeoutMs: numberEnv("DEPLOYER_HEALTH_TIMEOUT_MS", 2000),
  healthProbeFailThreshold: numberEnv("DEPLOYER_HEALTH_FAIL_THRESHOLD", 3),

  // Local-dev escape hatches. Setting SKIP_CADDY=true lets the worker
  // mark a deployment `running` without calling the Caddy admin API —
  // useful when you don't have Caddy running on your laptop. The UI
  // still shows the (fake) hostUrl, and the container is still reachable
  // at 127.0.0.1:<port> directly.
  skipCaddy: (process.env.DEPLOYER_SKIP_CADDY ?? "").toLowerCase() === "true",

  // Keep crashed container corpses around instead of sweeping them
  // immediately. Useful for debugging OOM kills and other exit=137
  // mysteries — you can `docker inspect` / `docker logs` the dead
  // container afterwards. The port is still released so new deploys
  // can proceed. Sweep manually with `docker rm $(docker ps -a -q
  // --filter label=zynd.deployment --filter status=exited)`.
  keepCrashedContainers:
    (process.env.DEPLOYER_KEEP_CRASHED_CONTAINERS ?? "").toLowerCase() === "true",

  // Public WebSocket log-tail port served by the worker. Clients
  // connect to wss://<deployer-host>:<port>/v1/agents/<entityId>/logs.
  // 0 disables the WS server (the SSE route on the Next app remains
  // available either way).
  wsLogsPort: numberEnv("DEPLOYER_WS_LOGS_PORT", 7071),

  // Path the *host's* Docker daemon sees for the deployer's data root.
  // When the worker itself runs in a container (docker-compose dev
  // setup), any path we hand to the daemon for a bind-mount needs to
  // be the host-side path, not the path inside the worker container.
  // Leave unset in production (worker runs on host, paths match).
  hostDataRoot: optional("HOST_DATA_ROOT", ""),
};

// Guard against obviously bad ranges at boot.
if (config.portMin >= config.portMax) {
  throw new Error(
    `DEPLOYER_PORT_MIN (${config.portMin}) must be less than DEPLOYER_PORT_MAX (${config.portMax})`
  );
}

// Paths derived from dataRoot.
export const paths = {
  blobs: `${config.dataRoot}/blobs`,
  keys: `${config.dataRoot}/keys`,
  work: `${config.dataRoot}/work`,
};

// Silence unused warning — keep this export so callers that `require()`
// this module still see it is loaded.
void required;
