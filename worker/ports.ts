// Port allocator. The PortAllocation table is the source of truth; we
// reserve with a transaction so two workers (if we ever scale out) don't
// hand out the same port.

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

export async function allocatePort(deploymentId: string): Promise<number> {
  // Pull the currently-taken set once, then pick the first free port.
  const taken = new Set(
    (await prisma.portAllocation.findMany({ select: { port: true } })).map(
      (r) => r.port
    )
  );

  for (let port = config.portMin; port <= config.portMax; port++) {
    if (taken.has(port)) continue;
    try {
      await prisma.portAllocation.create({
        data: { port, deploymentId },
      });
      return port;
    } catch {
      // Someone else grabbed it between the read and the insert;
      // just try the next one.
      continue;
    }
  }
  throw new Error(
    `No free ports in range ${config.portMin}-${config.portMax}`
  );
}

export async function releasePort(deploymentId: string): Promise<void> {
  await prisma.portAllocation
    .deleteMany({ where: { deploymentId } })
    .catch(() => undefined);
}
