// docker events watcher. One long-lived connection; for every `die`
// event on a `zynd-<id>` container, we capture the exit code + log tail
// and mark the deployment crashed.

import {
  docker,
  inspectExitCode,
  inspectTerminalState,
  stopAndRemove,
  tailLogs,
} from "./docker";
import { prisma } from "@/lib/db";
import { appendSystemLog, stopTailer } from "./logs";
import { releasePort } from "./ports";

export async function watchCrashes(): Promise<void> {
  console.log("[crash watcher] attaching to docker events");
  // `docker events --filter type=container` stream. Dockerode returns a
  // raw stream of newline-delimited JSON objects.
  const stream = await docker.getEvents({
    filters: { type: ["container"] },
  });

  let buf = "";
  stream.on("data", async (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as {
          Action?: string;
          status?: string;
          Actor?: {
            ID?: string;
            Attributes?: Record<string, string>;
          };
        };
        const action = ev.Action ?? ev.status;
        if (!action) continue;

        // Only care about terminal events.
        if (action !== "die" && action !== "oom" && action !== "kill") continue;

        const labels = ev.Actor?.Attributes ?? {};
        const deploymentId = labels["zynd.deployment"];
        if (!deploymentId) continue;

        const containerId = ev.Actor?.ID;
        if (!containerId) continue;

        console.log(
          `[crash watcher] event action=${action} deployment=${deploymentId} ` +
            `container=${containerId.slice(0, 12)} ` +
            `labels=${JSON.stringify(labels)}`
        );

        const state = await inspectTerminalState(containerId);
        const exitCode =
          Number(labels["exitCode"]) ||
          state?.exitCode ||
          (await inspectExitCode(containerId)) ||
          null;
        const oomKilled = state?.oomKilled ?? false;
        const dockerErr = state?.error ?? "";

        // Unless it was a clean exit we got here from our own Stop flow,
        // mark the deployment crashed.
        const current = await prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { status: true },
        });
        if (!current) {
          console.log(
            `[crash watcher] deployment ${deploymentId} not found in DB, skipping`
          );
          continue;
        }

        // Ignore events for deployments the operator explicitly stopped.
        if (current.status === "stopped") {
          console.log(
            `[crash watcher] deployment ${deploymentId} already stopped, ignoring ${action}`
          );
          continue;
        }

        console.log(
          `[crash watcher] terminal deployment=${deploymentId} ` +
            `action=${action} exit=${exitCode ?? "?"} oomKilled=${oomKilled} ` +
            `memLimit=${state?.memoryLimitMb ?? "?"}MB ` +
            `dockerErr=${dockerErr || "(none)"} ` +
            `startedAt=${state?.startedAt ?? "?"} finishedAt=${state?.finishedAt ?? "?"} ` +
            `prevStatus=${current.status}`
        );

        const tail = (await tailLogs(containerId, 200)).trim();
        const reason = oomKilled
          ? `Container OOM-killed (memory limit ${state?.memoryLimitMb ?? "?"}MB)`
          : exitCode !== null
            ? `Container exited ${exitCode}`
            : "Container died unexpectedly";

        await prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: "crashed",
            lastExitCode: exitCode,
            lastCrashAt: new Date(),
            errorMessage: reason,
          },
        });

        const header = oomKilled
          ? `[CRASH exit=${exitCode ?? "?"} OOMKilled=true memLimit=${state?.memoryLimitMb ?? "?"}MB]`
          : `[CRASH exit=${exitCode ?? "?"}]`;
        await appendSystemLog(deploymentId, `${header}\n${tail.slice(-2000)}`);
        stopTailer(deploymentId);

        // Sweep the dead container + free its port. Logs are already
        // persisted in DeploymentLog, so the user still sees the last
        // ~200 lines on the /d/<id> page after this runs.
        await stopAndRemove(containerId).catch((err) => {
          console.error(`[crash watcher] sweep ${containerId} failed:`, err);
        });
        await releasePort(deploymentId).catch(() => undefined);
      } catch (e) {
        console.warn("[crash watcher] malformed event:", (e as Error).message);
      }
    }
  });

  stream.on("error", (e) => {
    console.error("[crash watcher]", e);
  });
}
