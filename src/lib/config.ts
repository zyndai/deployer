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

  // Local-dev escape hatches. Setting SKIP_CADDY=true lets the worker
  // mark a deployment `running` without calling the Caddy admin API —
  // useful when you don't have Caddy running on your laptop. The UI
  // still shows the (fake) hostUrl, and the container is still reachable
  // at 127.0.0.1:<port> directly.
  skipCaddy: (process.env.DEPLOYER_SKIP_CADDY ?? "").toLowerCase() === "true",

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
