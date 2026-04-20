// GET /api/deployments/[id]/logs?after=<lineNo>&limit=<n>
// Paginated read of the DeploymentLog table. The SSE stream route
// below (./stream/route.ts) uses this in its initial payload.

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;

  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? "0") || 0;
  const limitRaw = Number(url.searchParams.get("limit") ?? "500") || 500;
  const limit = Math.max(1, Math.min(limitRaw, 2000));

  const rows = await prisma.deploymentLog.findMany({
    where: {
      deploymentId: id,
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
    lines: rows.map((r) => ({
      lineNo: r.lineNo,
      text: r.text,
      stream: r.stream,
      ts: r.ts.toISOString(),
    })),
  });
}
