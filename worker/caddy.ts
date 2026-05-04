// Tiny Caddy admin API client. Routes are keyed by deployment id so we
// can update/delete them without walking the config tree.
//
// Assumes Caddy is configured at boot with an empty HTTPS server named
// "zynd" that has an @id-addressable routes array. See infra/Caddyfile.

import { config } from "@/lib/config";

interface CaddyRoute {
  "@id": string;
  match: Array<{ host?: string[]; path?: string[] }>;
  // Two-stage handler: rewrite strips the path prefix so the upstream
  // (which serves at root) sees the request as if it came in directly,
  // then reverse_proxy forwards it. Order matters — rewrite must run
  // before reverse_proxy.
  handle: Array<
    | { handler: "rewrite"; strip_path_prefix: string }
    | { handler: "reverse_proxy"; upstreams: Array<{ dial: string }> }
  >;
}

async function adminFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  // Caddy's admin API rejects requests whose Origin header isn't on
  // the configured allowlist. Node's fetch doesn't set Origin by
  // default, so the server sees origin '' and returns 403. Pin it to
  // the admin URL itself, which matches Caddy's default loopback
  // allowlist (127.0.0.1, localhost, ::1).
  const res = await fetch(`${config.caddyAdminUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: config.caddyAdminUrl,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

/**
 * Ensure the target Caddy server exists and has a `routes: []` array
 * we can append to. On a freshly-booted Caddy with no config loaded,
 * the HTTP app and the named server don't exist yet, so
 * POST .../routes/... fails with
 *   500 {"error":"final element is not an array"}
 * and every single deploy is torn down (the agent looked healthy up
 * to that point, then the deployer SIGKILLed it during cleanup).
 *
 * This is idempotent: if the server + routes array already exist,
 * the PATCH is a no-op against the current shape.
 */
export async function ensureServer(): Promise<void> {
  if (config.skipCaddy) return;

  // Probe first — if the server already has a routes array we're
  // done. We also accept a server that's there but with a missing
  // routes key (Caddy accepts that shape but the append endpoint
  // rejects it).
  const probe = await adminFetch(
    `/config/apps/http/servers/${config.caddyServerName}`,
    { method: "GET" }
  );
  if (probe.ok) {
    try {
      const body = (await probe.json()) as { routes?: unknown };
      if (Array.isArray(body.routes)) {
        return;
      }
    } catch {
      // probe returned 200 but not JSON — fall through and rewrite
    }
  }

  // Push the whole apps.http.servers.<name> sub-tree via POST /load.
  // Using /load (replaces full config) is more reliable than PUTing a
  // leaf path: on a freshly-booted Caddy the intermediate /apps/http
  // keys don't exist, and PUT to a missing parent returns 4xx. /load
  // is the documented way to bootstrap from an empty config.
  //
  // We fetch the existing config first so we don't blow away any
  // other apps the operator has configured (e.g. the admin listen
  // override in /etc/caddy/caddy.json).
  const currentRes = await adminFetch(`/config/`, { method: "GET" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = {};
  if (currentRes.ok) {
    try {
      current = await currentRes.json();
    } catch {
      current = {};
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const merged: any = { ...(current ?? {}) };
  merged.apps = { ...(merged.apps ?? {}) };
  merged.apps.http = { ...(merged.apps.http ?? {}) };
  merged.apps.http.servers = { ...(merged.apps.http.servers ?? {}) };
  const existing = merged.apps.http.servers[config.caddyServerName] ?? {};
  merged.apps.http.servers[config.caddyServerName] = {
    listen: Array.isArray(existing.listen) && existing.listen.length > 0
      ? existing.listen
      : [":443"],
    ...existing,
    routes: Array.isArray(existing.routes) ? existing.routes : [],
  };

  const load = await adminFetch(`/load`, {
    method: "POST",
    body: JSON.stringify(merged),
  });
  if (!load.ok) {
    const text = await load.text();
    throw new Error(
      `Caddy ensureServer failed: POST /load returned ${load.status} ${text}`
    );
  }

  // Re-probe to confirm the shape is right before we let addRoute run.
  const verify = await adminFetch(
    `/config/apps/http/servers/${config.caddyServerName}`,
    { method: "GET" }
  );
  if (!verify.ok) {
    throw new Error(
      `Caddy ensureServer: post-load probe returned ${verify.status}`
    );
  }
  const verifyBody = (await verify.json()) as { routes?: unknown };
  if (!Array.isArray(verifyBody.routes)) {
    throw new Error(
      `Caddy ensureServer: server "${config.caddyServerName}" has routes=${typeof verifyBody.routes} after /load — expected array`
    );
  }
  console.log(
    `[caddy] ensured server="${config.caddyServerName}" with empty routes[] ` +
      `(merged into ${Object.keys(merged.apps.http.servers).length} server(s))`
  );
}

export async function addRoute(
  deploymentId: string,
  slug: string,
  hostPort: number,
  entityType: "agent" | "service"
): Promise<void> {
  if (config.skipCaddy) return;
  const host = config.wildcardDomain;
  const prefix = `/${entityType}/${slug}`;
  // Match both the prefix exactly (so /agent/abc with no trailing
  // slash still routes) and any subpath under it. Caddy's path
  // matcher treats `/agent/abc/*` as "anything under /agent/abc/",
  // which excludes the bare /agent/abc.
  const route: CaddyRoute = {
    "@id": deploymentId,
    match: [{ host: [host], path: [prefix, `${prefix}/*`] }],
    handle: [
      { handler: "rewrite", strip_path_prefix: prefix },
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `127.0.0.1:${hostPort}` }],
      },
    ],
  };

  // Insert at the HEAD of the routes list. The Caddyfile-managed
  // catch-all for `deployer.zynd.ai` (which forwards to the Next UI on
  // :3000) lives further down the array; without prepending, Caddy's
  // first-match-wins eval would route `/agent/<slug>/*` requests to
  // Next instead of the container.
  //
  // We avoid POST .../routes/0 because its semantics differ across
  // Caddy versions — some treat the trailing index as "insert at",
  // others as "append to array named 0". Instead: fetch the current
  // routes, unshift our entry, PUT the whole array back. This is
  // atomic from Caddy's view (a single config mutation) and works
  // identically everywhere.
  await prependRoute(route);
}

async function prependRoute(route: CaddyRoute): Promise<void> {
  const path = `/config/apps/http/servers/${config.caddyServerName}/routes`;

  const readCurrent = async (): Promise<CaddyRoute[]> => {
    const r = await adminFetch(path, { method: "GET" });
    if (!r.ok) return [];
    const body = (await r.json()) as unknown;
    return Array.isArray(body) ? (body as CaddyRoute[]) : [];
  };

  let current = await readCurrent();
  if (current.length === 0) {
    // Might be empty or the server itself might be missing — try to
    // bootstrap and re-read.
    await ensureServer();
    current = await readCurrent();
  }

  // Drop any existing entry with the same @id so redeploys don't
  // accumulate duplicates. addRoute is also called after a stop/
  // restart cycle.
  const deduped = current.filter((r) => r["@id"] !== route["@id"]);
  const next = [route, ...deduped];

  // PATCH replaces the existing value at the path. PUT errors with
  // 409 "key already exists" when the array is already present,
  // which is every case except a brand-new server.
  const res = await adminFetch(path, {
    method: "PATCH",
    body: JSON.stringify(next),
  });
  if (!res.ok) {
    throw new Error(
      `Caddy addRoute failed: PATCH ${path} returned ${res.status} ${await res.text()}`
    );
  }
  const m = route.match[0];
  const host = m.host?.[0] ?? "*";
  const pathDesc = m.path?.join(",") ?? "*";
  console.log(
    `[caddy] prepended route id=${route["@id"]} host=${host} path=${pathDesc} (routes=${next.length})`
  );
}

export async function removeRoute(deploymentId: string): Promise<void> {
  if (config.skipCaddy) return;
  const res = await adminFetch(`/id/${deploymentId}`, {
    method: "DELETE",
  });
  // 404 means the route already went away — idempotent for our use.
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Caddy removeRoute failed: ${res.status} ${await res.text()}`
    );
  }
}
