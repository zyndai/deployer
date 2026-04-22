// Per-container CPU / memory sampler.
//
// Every DEPLOYER_METRICS_INTERVAL_SEC seconds we fetch `docker stats`
// (single-shot, not a stream) for each running deployment and write a
// row into DeploymentMetric. The UI can chart memory growth and catch
// a slow leak before the agent hits its cgroup limit and gets killed
// at exit=137.
//
// We intentionally use the single-shot stats API rather than a
// per-container `stats({stream: true})` subscription: opening 50
// long-lived stat streams keeps 50 sockets hot against the docker
// daemon and multiplies its CPU cost. A sequential sweep on a timer
// costs one request per container per interval.
//
// Failures are logged but don't stop the loop; a container that went
// away between the running-query and the stats call just has its
// sample skipped.

import { docker } from "./docker";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

// Dockerode's stats payload is not typed in the public interface but
// the shape is stable across daemon versions — only pick what we use.
interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
  };
}

/**
 * CPU fraction of ONE logical CPU, per Docker's documented formula:
 *
 *   delta_container / delta_system  * online_cpus
 *
 * Returned as a number in [0, online_cpus]. The UI can divide by
 * online_cpus if it wants a 0..1 fraction of total host capacity.
 */
function computeCpuPct(s: DockerStats): number {
  const cpu = s.cpu_stats?.cpu_usage?.total_usage ?? 0;
  const preCpu = s.precpu_stats?.cpu_usage?.total_usage ?? 0;
  const sys = s.cpu_stats?.system_cpu_usage ?? 0;
  const preSys = s.precpu_stats?.system_cpu_usage ?? 0;
  const online = s.cpu_stats?.online_cpus ?? 1;

  const cpuDelta = cpu - preCpu;
  const sysDelta = sys - preSys;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  return (cpuDelta / sysDelta) * online;
}

async function sampleOne(deploymentId: string, containerId: string): Promise<void> {
  try {
    // dockerode accepts stream: false to return a single Promise<stats>
    // instead of a long-lived ReadableStream.
    const raw = (await docker
      .getContainer(containerId)
      .stats({ stream: false })) as unknown as DockerStats;

    const memUsed = raw.memory_stats?.usage ?? 0;
    const memLimit = raw.memory_stats?.limit ?? 0;
    const cpuPct = computeCpuPct(raw);

    await prisma.deploymentMetric.create({
      data: {
        deploymentId,
        memUsedMb: Math.round(memUsed / 1024 / 1024),
        memLimitMb: Math.round(memLimit / 1024 / 1024),
        cpuPct,
      },
    });
  } catch (e) {
    // Container may have exited between findMany and stats. Log once
    // per sample miss; don't spam the error channel on every tick.
    console.warn(
      `[metrics] sample deployment=${deploymentId} container=${containerId.slice(0, 12)} failed: ${(e as Error).message}`
    );
  }
}

export async function sampleMetrics(): Promise<void> {
  const running = await prisma.deployment.findMany({
    where: { status: "running", containerId: { not: null } },
    select: { id: true, containerId: true },
  });
  if (running.length === 0) return;

  const started = Date.now();
  // Run sequentially to avoid hammering the docker daemon with 50
  // parallel stats requests. Each call is <100ms so a full sweep of
  // 50 containers is ~3-5s, well inside a 30s interval.
  for (const r of running) {
    if (!r.containerId) continue;
    await sampleOne(r.id, r.containerId);
  }
  console.log(
    `[metrics] sampled ${running.length} container(s) in ${Date.now() - started}ms`
  );
}

export function startMetricsLoop(): void {
  const sec = Math.max(5, config.metricsIntervalSeconds);
  console.log(`[metrics] loop starting (interval=${sec}s)`);
  setInterval(() => {
    sampleMetrics().catch((e) => console.error("[metrics] sweep failed:", e));
  }, sec * 1000);
}
