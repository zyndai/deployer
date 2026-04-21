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
  const res = await adminFetch(`/config/apps/http/servers/${config.caddyServerName}/routes/...`, {
    method: "POST",
    body: JSON.stringify(route),
  });
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
