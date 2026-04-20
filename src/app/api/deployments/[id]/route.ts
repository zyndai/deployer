// GET    /api/deployments/[id]  — detail
// DELETE /api/deployments/[id]  — stop the deployment

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { ACTIVE_STATUSES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Next 15 passes params as a Promise. Keep the type explicit so we don't
// silently forget to await it.
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const dep = await prisma.deployment.findUnique({ where: { id } });
  if (!dep) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: dep.id,
    name: dep.name,
    slug: dep.slug,
    entityType: dep.entityType,
    entityId: dep.entityId,
    registryUrl: dep.registryUrl,
    status: dep.status,
    errorMessage: dep.errorMessage,
    port: dep.port,
    containerId: dep.containerId,
    hostUrl: dep.hostUrl,
    publicKeyB64: dep.publicKeyB64,
    lastExitCode: dep.lastExitCode,
    lastCrashAt: dep.lastCrashAt,
    createdAt: dep.createdAt,
    startedAt: dep.startedAt,
    stoppedAt: dep.stoppedAt,
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const dep = await prisma.deployment.findUnique({ where: { id } });
  if (!dep) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Mark for stop. Actual docker rm + caddy route deletion is the
  // worker's job — the API never touches the docker socket directly so
  // the concurrency story stays single-writer.
  if (ACTIVE_STATUSES.includes(dep.status as (typeof ACTIVE_STATUSES)[number])) {
    await prisma.deployment.update({
      where: { id },
      data: {
        status: "stopped",
        stoppedAt: new Date(),
      },
    });
  }

  return NextResponse.json({ ok: true });
}
