// docker events watcher. One long-lived connection; for every `die`
// event on a `zynd-<id>` container, we capture the exit code + log tail
// and mark the deployment crashed.

import { docker, inspectExitCode, stopAndRemove, tailLogs } from "./docker";
import { prisma } from "@/lib/db";
import { appendSystemLog, stopTailer } from "./logs";
import { releasePort } from "./ports";

export async function watchCrashes(): Promise<void> {
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

        const exitCode =
          Number(labels["exitCode"]) ||
          (await inspectExitCode(containerId)) ||
          null;

        // Unless it was a clean exit we got here from our own Stop flow,
        // mark the deployment crashed.
        const current = await prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { status: true },
        });
        if (!current) continue;

        // Ignore events for deployments the operator explicitly stopped.
        if (current.status === "stopped") continue;

        const tail = (await tailLogs(containerId, 200)).trim();
        await prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: "crashed",
            lastExitCode: exitCode,
            lastCrashAt: new Date(),
            errorMessage:
              exitCode !== null
                ? `Container exited ${exitCode}`
                : "Container died unexpectedly",
          },
        });

        await appendSystemLog(
          deploymentId,
          `[CRASH exit=${exitCode ?? "?"}]\n${tail.slice(-2000)}`
        );
        stopTailer(deploymentId);

        // Sweep the dead container + free its port. Logs are already
        // persisted in DeploymentLog, so the user still sees the last
        // ~200 lines on the /d/<id> page after this runs.
        await stopAndRemove(containerId).catch((err) => {
          console.error(`[crash watcher] sweep ${containerId} failed:`, err);
        });
        await releasePort(deploymentId).catch(() => undefined);
      } catch {
        // ignore malformed events
      }
    }
  });

  stream.on("error", (e) => {
    console.error("[crash watcher]", e);
  });
}
