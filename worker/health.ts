// Periodic liveness probe.
//
// The crash watcher catches containers that EXIT — it does not catch
// the case where the Python process is still alive but stuck (deadlock,
// stalled event loop, blocked on a hung upstream). This loop hits
// http://127.0.0.1:<port>/health for every running deployment and flips
// the row to `unhealthy` after DEPLOYER_HEALTH_FAIL_THRESHOLD
// consecutive failures. A successful probe resets the counter.
//
// We keep the fail counter in-process rather than in the DB: the state
// is purely ephemeral, reset on worker restart is fine (the probe will
// re-fail three times and mark it again within a minute), and a DB
// column per probe result would add pointless write traffic.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { appendSystemLog } from "./logs";

const failCounts = new Map<string, number>();

async function probeOne(deploymentId: string, port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(config.healthProbeTimeoutMs),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function markUnhealthy(deploymentId: string, port: number): Promise<void> {
  // Only transition from `running` — if the deployment is already
  // crashed/stopped/failed/unhealthy, leave the status alone.
  const updated = await prisma.deployment.updateMany({
    where: { id: deploymentId, status: "running" },
    data: { status: "unhealthy" },
  });
  if (updated.count > 0) {
    await appendSystemLog(
      deploymentId,
      `[UNHEALTHY] /health probe failed ${config.healthProbeFailThreshold} times in a row on port ${port}`
    ).catch(() => undefined);
    console.warn(
      `[health] deployment=${deploymentId} port=${port} marked unhealthy ` +
        `after ${config.healthProbeFailThreshold} consecutive failures`
    );
  }
}

export async function probeAll(): Promise<void> {
  // Probe both `running` (normal case) and `unhealthy` (so we can
  // recover to `running` if /health comes back).
  const targets = await prisma.deployment.findMany({
    where: {
      status: { in: ["running", "unhealthy"] },
      port: { not: null },
    },
    select: { id: true, port: true, status: true },
  });
  if (targets.length === 0) return;

  const started = Date.now();
  let recovered = 0;
  let newlyUnhealthy = 0;

  // Probe in parallel — each request is small (2s max timeout) and
  // fetches to localhost are cheap. 50 agents completes in <2s.
  await Promise.all(
    targets.map(async (t) => {
      if (t.port === null) return;
      const ok = await probeOne(t.id, t.port);

      if (ok) {
        // Clear counter. If we were in `unhealthy`, flip back to
        // `running` and record it.
        failCounts.delete(t.id);
        if (t.status === "unhealthy") {
          const u = await prisma.deployment.updateMany({
            where: { id: t.id, status: "unhealthy" },
            data: { status: "running" },
          });
          if (u.count > 0) {
            recovered++;
            await appendSystemLog(
              t.id,
              `[RECOVERED] /health is responsive again on port ${t.port}`
            ).catch(() => undefined);
          }
        }
        return;
      }

      const next = (failCounts.get(t.id) ?? 0) + 1;
      failCounts.set(t.id, next);
      if (next >= config.healthProbeFailThreshold && t.status === "running") {
        await markUnhealthy(t.id, t.port);
        newlyUnhealthy++;
      }
    })
  );

  console.log(
    `[health] probed ${targets.length} target(s) in ${Date.now() - started}ms ` +
      `(newlyUnhealthy=${newlyUnhealthy} recovered=${recovered})`
  );
}

export function startHealthLoop(): void {
  const sec = Math.max(5, config.healthProbeIntervalSeconds);
  console.log(
    `[health] loop starting (interval=${sec}s threshold=${config.healthProbeFailThreshold})`
  );
  setInterval(() => {
    probeAll().catch((e) => console.error("[health] sweep failed:", e));
  }, sec * 1000);
}
