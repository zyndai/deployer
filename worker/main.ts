// Worker entry point. Runs as its own long-lived process (systemd unit:
// zynd-deployer-worker.service). Two loops:
//
//  1. drain queue: claim `queued` deployments and drive them through
//     the state machine defined in lifecycle.ts.
//  2. reconcile stops: watch for rows flipped to `stopped` by the API
//     and tear down the container + Caddy route.
//
// A third concern (`docker events` watcher) lives in crash.ts and runs
// as a sibling once at startup.

// For local dev, run with: `node --env-file=.env --import tsx/esm worker/main.ts`
// or `pnpm worker:dev`. Production uses systemd's EnvironmentFile.

import { prisma } from "@/lib/db";
import { drive } from "./lifecycle";
import { watchCrashes } from "./crash";
import { stopAndRemove } from "./docker";
import { removeRoute } from "./caddy";
import { releasePort } from "./ports";
import { appendSystemLog, stopTailer, startTailer } from "./logs";
import { startRetentionLoop } from "./retention";

const TICK_MS = 1000;

async function drainQueue(): Promise<void> {
  // Claim the oldest queued row. The `status=starting` update acts as a
  // pessimistic lock — if another worker beat us to it, the returned
  // count will be 0 and we just loop.
  const candidate = await prisma.deployment.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!candidate) return;

  const claimed = await prisma.deployment.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: { status: "unpacking" },
  });
  if (claimed.count === 0) {
    console.log(`[worker] lost race to claim ${candidate.id}, retrying`);
    return;
  }

  console.log(`[worker] claimed deployment=${candidate.id}, driving`);
  const t0 = Date.now();

  // Drive in the foreground. We don't fire and forget because we want
  // serial execution per worker — PLAN.md calls for one VM for v1.
  try {
    await drive(candidate.id);
    console.log(
      `[worker] drive(${candidate.id}) finished in ${Date.now() - t0}ms`
    );
  } catch (e) {
    console.error(
      `[worker] drive(${candidate.id}) threw after ${Date.now() - t0}ms:`,
      e
    );
  }
}

async function drainStops(): Promise<void> {
  const stopped = await prisma.deployment.findMany({
    where: {
      status: "stopped",
      containerId: { not: null },
    },
    select: { id: true, containerId: true },
  });

  if (stopped.length > 0) {
    console.log(`[worker] draining ${stopped.length} stopped deployment(s)`);
  }

  for (const row of stopped) {
    console.log(
      `[worker] cleaning up stopped deployment=${row.id} container=${row.containerId?.slice(0, 12)}`
    );
    stopTailer(row.id);

    // Run each external step independently so one failure doesn't
    // block the others and trap the row in drainStops forever.
    const errors: string[] = [];
    if (row.containerId) {
      try {
        await stopAndRemove(row.containerId);
      } catch (e) {
        errors.push(`stopAndRemove: ${(e as Error).message}`);
      }
    }
    try {
      await removeRoute(row.id);
    } catch (e) {
      errors.push(`removeRoute: ${(e as Error).message}`);
    }
    try {
      await releasePort(row.id);
    } catch (e) {
      errors.push(`releasePort: ${(e as Error).message}`);
    }

    // Always clear containerId/port so the drainStops query stops
    // selecting this row. If external cleanup genuinely leaked a
    // container or route, the operator needs to see it once and fix
    // it — better than a wedged worker emitting the same 403 every
    // second.
    try {
      await prisma.deployment.update({
        where: { id: row.id },
        data: { containerId: null, port: null },
      });
    } catch (e) {
      console.error(
        `[worker] could not clear containerId for ${row.id} — will retry next tick:`,
        e
      );
      continue;
    }

    if (errors.length === 0) {
      await appendSystemLog(row.id, "[worker] cleaned up on stop");
    } else {
      console.error(
        `[worker] stop cleanup ${row.id} had ${errors.length} error(s), row cleared anyway: ${errors.join("; ")}`
      );
      await appendSystemLog(
        row.id,
        `[worker] cleaned up with errors: ${errors.join("; ")}`
      ).catch(() => undefined);
    }
  }
}

async function resumeTailers(): Promise<void> {
  // After a restart, re-attach log tailers to any still-running
  // deployment so the live-log view keeps working.
  const running = await prisma.deployment.findMany({
    where: { status: "running", containerId: { not: null } },
    select: { id: true, containerId: true },
  });
  for (const r of running) {
    if (r.containerId) {
      startTailer(r.id, r.containerId).catch((e) =>
        console.warn(`[worker] resume tailer ${r.id}:`, e)
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("[worker] starting");
  await resumeTailers();
  watchCrashes().catch((e) => console.error("[worker] crash watcher died:", e));
  startRetentionLoop();

  // Graceful shutdown so systemd sees a clean exit.
  const shutdown = () => {
    console.log("[worker] shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await drainQueue();
      await drainStops();
    } catch (e) {
      console.error("[worker] tick failed:", e);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
