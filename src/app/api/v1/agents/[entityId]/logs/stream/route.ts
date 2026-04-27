// GET /api/v1/agents/[entityId]/logs/stream
//
// Server-Sent Events live tail keyed by entity_id (the id the agent
// reports via /.well-known/agent.json, which the worker backfills onto
// Deployment.entityId).
//
// Note: Next.js App Router route handlers cannot upgrade to a real
// WebSocket connection — there is no `Upgrade` hook in the route runtime.
// SSE is the supported transport here. EventSource clients reconnect
// automatically on drop; for polyglot clients there is a polling REST
// fallback at /api/v1/agents/[entityId]/logs.

import { prisma } from "@/lib/db";
import { TERMINAL_STATUSES } from "@/lib/types";
import { resolveByEntityId } from "@/lib/resolveDeployment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ entityId: string }> };

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request, { params }: Ctx) {
  const { entityId } = await params;

  const dep = await resolveByEntityId(entityId);
  if (!dep) {
    return new Response(`No deployment for entity_id ${entityId}`, {
      status: 404,
    });
  }
  const id = dep.id;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastLine = 0;
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      write(sse("hello", { deploymentId: id, entityId }));

      const initial = await prisma.deploymentLog.findMany({
        where: { deploymentId: id },
        orderBy: { lineNo: "desc" },
        take: 500,
        select: { lineNo: true, text: true, stream: true, ts: true },
      });
      for (const row of initial.reverse()) {
        write(
          sse("log", {
            lineNo: row.lineNo,
            text: row.text,
            stream: row.stream,
            ts: row.ts.toISOString(),
          })
        );
        lastLine = Math.max(lastLine, row.lineNo);
      }
      write(sse("ready", { lastLine }));

      const heartbeat = setInterval(() => write(": keepalive\n\n"), HEARTBEAT_MS);

      const poll = setInterval(async () => {
        if (closed) return;
        try {
          const newRows = await prisma.deploymentLog.findMany({
            where: { deploymentId: id, lineNo: { gt: lastLine } },
            orderBy: { lineNo: "asc" },
            take: 1000,
            select: { lineNo: true, text: true, stream: true, ts: true },
          });
          for (const row of newRows) {
            write(
              sse("log", {
                lineNo: row.lineNo,
                text: row.text,
                stream: row.stream,
                ts: row.ts.toISOString(),
              })
            );
            lastLine = row.lineNo;
          }

          const current = await prisma.deployment.findUnique({
            where: { id },
            select: { status: true },
          });
          if (
            current &&
            TERMINAL_STATUSES.includes(
              current.status as (typeof TERMINAL_STATUSES)[number]
            ) &&
            current.status !== "running"
          ) {
            write(sse("done", { status: current.status }));
            clearInterval(poll);
            clearInterval(heartbeat);
            closed = true;
            try {
              controller.close();
            } catch {
              // noop
            }
          }
        } catch (e) {
          write(sse("error", { message: (e as Error).message }));
        }
      }, POLL_MS);

      req.signal.addEventListener("abort", () => {
        clearInterval(poll);
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // noop
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
