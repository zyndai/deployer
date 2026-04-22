// Tiny Caddy admin API client. Routes are keyed by deployment id so we
// can update/delete them without walking the config tree.
//
// Assumes Caddy is configured at boot with an empty HTTPS server named
// "zynd" that has an @id-addressable routes array. See infra/Caddyfile.

import { config } from "@/lib/config";

interface CaddyRoute {
  "@id": string;
  match: Array<{ host: string[] }>;
  handle: Array<{
    handler: "reverse_proxy";
    upstreams: Array<{ dial: string }>;
  }>;
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

  // Probe the server first. 200 with a JSON body containing "routes":[…]
  // means we're already set up. 404 means the server doesn't exist at
  // all. Anything else we try to fix by writing the whole server block.
  const probe = await adminFetch(
    `/config/apps/http/servers/${config.caddyServerName}`,
    { method: "GET" }
  );
  if (probe.ok) {
    const body = (await probe.json()) as { routes?: unknown };
    if (Array.isArray(body.routes)) return;
  }

  // Write a minimal server with the right listen + an empty routes
  // array so the append endpoint works. Uses PUT on the server key so
  // we replace the whole sub-tree atomically rather than patching
  // field-by-field and racing with another caller.
  const serverBody = {
    listen: [":443"],
    routes: [] as unknown[],
  };
  const ensured = await adminFetch(
    `/config/apps/http/servers/${config.caddyServerName}`,
    {
      method: "PUT",
      body: JSON.stringify(serverBody),
    }
  );
  if (!ensured.ok) {
    // The server key doesn't exist yet — push a whole apps.http.servers
    // object with our server inside. Covers the fresh-Caddy case.
    const full = {
      apps: {
        http: {
          servers: {
            [config.caddyServerName]: serverBody,
          },
        },
      },
    };
    const load = await adminFetch(`/load`, {
      method: "POST",
      body: JSON.stringify(full),
    });
    if (!load.ok) {
      throw new Error(
        `Caddy ensureServer failed: PUT=${ensured.status} LOAD=${load.status} ` +
          `${await load.text()}`
      );
    }
  }
  console.log(
    `[caddy] ensured server="${config.caddyServerName}" with empty routes[]`
  );
}

export async function addRoute(
  deploymentId: string,
  slug: string,
  hostPort: number
): Promise<void> {
  if (config.skipCaddy) return;
  const host = `${slug}.${config.wildcardDomain}`;
  const route: CaddyRoute = {
    "@id": deploymentId,
    match: [{ host: [host] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `127.0.0.1:${hostPort}` }],
      },
    ],
  };

  // Append to the configured zynd server's routes list. Caddy's
  // POST /config/<path> semantics: posting to a path that ends in `...`
  // appends to the list.
  let res = await adminFetch(`/config/apps/http/servers/${config.caddyServerName}/routes/...`, {
    method: "POST",
    body: JSON.stringify(route),
  });

  // If the routes list doesn't exist yet, bootstrap the server and
  // retry once. This keeps first-deploy-after-Caddy-restart working
  // without a manual curl against /load.
  if (!res.ok && res.status === 500) {
    const text = await res.text();
    if (text.includes("final element is not an array")) {
      console.warn(
        `[caddy] routes array missing on server="${config.caddyServerName}", bootstrapping`
      );
      await ensureServer();
      res = await adminFetch(
        `/config/apps/http/servers/${config.caddyServerName}/routes/...`,
        { method: "POST", body: JSON.stringify(route) }
      );
    } else {
      throw new Error(`Caddy addRoute failed: ${res.status} ${text}`);
    }
  }
  if (!res.ok) {
    throw new Error(
      `Caddy addRoute failed: ${res.status} ${await res.text()}`
    );
  }
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
