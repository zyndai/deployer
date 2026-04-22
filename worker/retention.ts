// Log retention. DeploymentLog grows unbounded (one row per container
// stdout/stderr line), so we delete rows older than the configured
// window on a periodic timer. System lines are kept longer because
// they're what the UI shows for post-mortems.
//
// Deletes run in batches so a large sweep doesn't hold a long
// transaction against an active table.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

const BATCH_SIZE = 10_000;

async function pruneStream(
  stream: "stdout" | "stderr" | "system",
  olderThan: Date
): Promise<number> {
  let deleted = 0;
  // Loop until no batch has anything left to delete. Prisma's
  // deleteMany returns { count }, but there's no LIMIT, so we do the
  // cap with a subquery via $executeRaw.
  while (true) {
    const n = await prisma.$executeRaw`
      DELETE FROM "DeploymentLog"
      WHERE id IN (
        SELECT id FROM "DeploymentLog"
        WHERE "stream" = ${stream} AND "ts" < ${olderThan}
        LIMIT ${BATCH_SIZE}
      )
    `;
    deleted += Number(n);
    if (Number(n) < BATCH_SIZE) break;
  }
  return deleted;
}

export async function pruneOldLogs(): Promise<void> {
  const lineDays = config.logRetentionDays;
  const sysDays = config.systemLogRetentionDays;
  if (lineDays <= 0 && sysDays <= 0) return;

  const now = Date.now();
  const started = now;

  let lineDeleted = 0;
  let sysDeleted = 0;

  if (lineDays > 0) {
    const cutoff = new Date(now - lineDays * 86_400_000);
    lineDeleted =
      (await pruneStream("stdout", cutoff)) +
      (await pruneStream("stderr", cutoff));
  }

  if (sysDays > 0) {
    const cutoff = new Date(now - sysDays * 86_400_000);
    sysDeleted = await pruneStream("system", cutoff);
  }

  console.log(
    `[retention] pruned ${lineDeleted} stdout/stderr + ${sysDeleted} system log rows in ${Date.now() - started}ms`
  );
}

export function startRetentionLoop(): void {
  const intervalMs = Math.max(1, config.retentionIntervalMinutes) * 60_000;
  console.log(
    `[retention] loop starting (lineDays=${config.logRetentionDays} ` +
      `systemDays=${config.systemLogRetentionDays} intervalMin=${config.retentionIntervalMinutes})`
  );
  // Run once on startup so we catch up from whatever accumulated
  // while the worker was down. Swallow errors — don't let the
  // retention task kill the worker.
  pruneOldLogs().catch((e) => console.error("[retention] initial prune failed:", e));
  setInterval(() => {
    pruneOldLogs().catch((e) => console.error("[retention] prune failed:", e));
  }, intervalMs);
}
