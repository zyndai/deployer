// GET /api/deployments/[id]/logs/stream
//
// Server-Sent Events live log tail. We don't use WebSockets because SSE
// is one-way, reconnects itself, and survives standard HTTP middleware.
//
// Strategy: poll DeploymentLog for rows with lineNo > last-seen every
// 500ms. Simple and good enough for v1 (PLAN.md §7). If we start seeing
// hundreds of concurrent viewers, swap to Postgres LISTEN/NOTIFY.

import { prisma } from "@/lib/db";
import { TERMINAL_STATUSES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;

  const dep = await prisma.deployment.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!dep) {
    return new Response("Not found", { status: 404 });
  }

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

      // Kick things off with the latest 500 lines so the viewer sees
      // context immediately after opening the page.
      const initial = await prisma.deploymentLog.findMany({
        where: { deploymentId: id },
        orderBy: { lineNo: "desc" },
        take: 500,
        select: { lineNo: true, text: true, stream: true, ts: true },
      });
      const ordered = initial.reverse();
      for (const row of ordered) {
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

          // Close the stream once we've drained logs for a terminal
          // deployment. The browser EventSource will just show "closed"
          // and stop trying to reconnect.
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
            // Give the UI a hint and close.
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

      // Client disconnect — tear down both timers so we don't leak.
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
