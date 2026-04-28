// GET /api/stats
//
// Aggregate dashboard data: capacity, memory headroom, per-container
// live samples. Reads the most recent DeploymentMetric row written by
// worker/metrics.ts for each running deployment.
//
// The freshness of the per-container samples is bounded by
// DEPLOYER_METRICS_INTERVAL_SEC (default 30s). Lower it if you want
// the dashboard to feel closer to real time — at the cost of more
// rows in DeploymentMetric. The endpoint returns `metricsIntervalSec`
// so the UI can show "<= Xs ago" honestly instead of pretending it's
// always live.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { ACTIVE_STATUSES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ContainerSample {
  id: string;
  name: string;
  slug: string;
  entityType: "agent" | "service";
  entityId: string | null;
  status: string;
  memUsedMb: number | null;
  memLimitMb: number | null;
  cpuPct: number | null;
  sampledAt: string | null;
  ageMs: number | null;
}

export async function GET() {
  const now = Date.now();

  const [activeCount, runningRows] = await Promise.all([
    prisma.deployment.count({
      where: { status: { in: ACTIVE_STATUSES } },
    }),
    prisma.deployment.findMany({
      where: { status: { in: ["running", "unhealthy"] }, containerId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        entityType: true,
        entityId: true,
        status: true,
      },
    }),
  ]);

  // Latest sample per running deployment. N+1 is fine here — capped
  // by maxActive (default 50). Index is (deploymentId, sampledAt).
  const samples = await Promise.all(
    runningRows.map(async (r) => {
      const latest = await prisma.deploymentMetric.findFirst({
        where: { deploymentId: r.id },
        orderBy: { sampledAt: "desc" },
        select: { memUsedMb: true, memLimitMb: true, cpuPct: true, sampledAt: true },
      });
      const out: ContainerSample = {
        id: r.id,
        name: r.name,
        slug: r.slug,
        entityType: r.entityType as "agent" | "service",
        entityId: r.entityId,
        status: r.status,
        memUsedMb: latest?.memUsedMb ?? null,
        memLimitMb: latest?.memLimitMb ?? null,
        cpuPct: latest?.cpuPct ?? null,
        sampledAt: latest?.sampledAt.toISOString() ?? null,
        ageMs: latest ? now - latest.sampledAt.getTime() : null,
      };
      return out;
    })
  );

  const totalUsedMb = samples.reduce((acc, s) => acc + (s.memUsedMb ?? 0), 0);
  const totalReservedMb = activeCount * config.containerMemoryMb;
  const free = Math.max(0, config.maxActive - activeCount);

  return NextResponse.json({
    capacity: {
      maxActive: config.maxActive,
      active: activeCount,
      free,
      containerMemoryMb: config.containerMemoryMb,
      containerCpuMillis: config.containerCpuMillis,
      totalReservedMb,
      totalUsedMb,
      totalFreeReservedMb: Math.max(0, totalReservedMb - totalUsedMb),
    },
    containers: samples,
    metricsIntervalSec: config.metricsIntervalSeconds,
    serverTime: new Date(now).toISOString(),
  });
}
