// Resolve a Deployment row by either internal id or by the agent-reported
// entityId. Used by the public /api/v1/agents/<entityId>/* endpoints so
// callers can use the registry-facing id they already know.
//
// Returns the latest matching row when more than one deployment has used
// the same entityId (e.g. redeploys) — newest createdAt wins.

import { prisma } from "@/lib/db";

export interface ResolvedDeployment {
  id: string;
  status: string;
}

export async function resolveByEntityId(
  entityId: string
): Promise<ResolvedDeployment | null> {
  const row = await prisma.deployment.findFirst({
    where: { entityId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  return row;
}
