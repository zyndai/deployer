// GET /api/v1/agents/[entityId]/logs?after=<lineNo>&limit=<n>
// Public, entity_id-keyed paginated log read. Mirrors the
// /api/deployments/[id]/logs route but accepts the registry entity_id
// instead of the deployer's internal deployment id.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { resolveByEntityId } from "@/lib/resolveDeployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ entityId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { entityId } = await params;

  const dep = await resolveByEntityId(entityId);
  if (!dep) {
    return NextResponse.json(
      { error: `No deployment found for entity_id ${entityId}` },
      { status: 404 }
    );
  }

  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? "0") || 0;
  const limitRaw = Number(url.searchParams.get("limit") ?? "500") || 500;
  const limit = Math.max(1, Math.min(limitRaw, 2000));

  const rows = await prisma.deploymentLog.findMany({
    where: {
      deploymentId: dep.id,
      lineNo: { gt: after },
    },
    orderBy: { lineNo: "asc" },
    take: limit,
    select: {
      lineNo: true,
      text: true,
      stream: true,
      ts: true,
    },
  });

  return NextResponse.json({
    deploymentId: dep.id,
    status: dep.status,
    lines: rows.map((r) => ({
      lineNo: r.lineNo,
      text: r.text,
      stream: r.stream,
      ts: r.ts.toISOString(),
    })),
  });
}
