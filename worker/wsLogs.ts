// WebSocket log-tail server hosted in the worker process.
//
// Path:  /v1/agents/<entityId>/logs[?after=<lineNo>]
// Frame: each message is a JSON object — see types below.
//
// Polling DeploymentLog is the same primitive the SSE route uses
// (src/app/api/v1/agents/[entityId]/logs/stream/route.ts). We keep the
// worker's WS server independent of Next.js because Next App Router
// route handlers cannot upgrade a request to a WebSocket — there's no
// raw socket access in the route runtime.

import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { prisma } from "@/lib/db";
import { config } from "@/lib/config";
import { TERMINAL_STATUSES } from "@/lib/types";

interface ClientState {
  deploymentId: string;
  entityId: string;
  lastLine: number;
  pollHandle: NodeJS.Timeout;
  pingHandle: NodeJS.Timeout;
  alive: boolean;
}

const POLL_MS = 500;
const PING_MS = 25_000;

function send(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

async function resolveByEntityId(entityId: string) {
  return prisma.deployment.findFirst({
    where: { entityId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
}

function parsePath(url: string | undefined): { entityId: string; after: number } | null {
  if (!url) return null;
  const u = new URL(url, "http://placeholder");
  // Expect /v1/agents/<entityId>/logs
  const parts = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "v1" || parts[1] !== "agents" || parts[3] !== "logs") return null;
  const entityId = decodeURIComponent(parts[2]);
  if (!entityId) return null;
  const afterRaw = u.searchParams.get("after");
  const after = afterRaw ? Math.max(0, Number(afterRaw) || 0) : 0;
  return { entityId, after };
}

async function streamLogs(ws: WebSocket, entityId: string, afterStart: number): Promise<void> {
  const dep = await resolveByEntityId(entityId);
  if (!dep) {
    send(ws, "error", {
      code: "not_found",
      message: `No deployment for entity_id ${entityId}`,
    });
    ws.close(4404, "not_found");
    return;
  }

  const state: ClientState = {
    deploymentId: dep.id,
    entityId,
    lastLine: afterStart,
    alive: true,
    pollHandle: setInterval(() => undefined, 1 << 30), // placeholder, replaced below
    pingHandle: setInterval(() => undefined, 1 << 30),
  };
  clearInterval(state.pollHandle);
  clearInterval(state.pingHandle);

  send(ws, "hello", { deploymentId: dep.id, entityId, status: dep.status });

  // Backfill: if the caller didn't pass `after`, replay last 500.
  if (afterStart === 0) {
    const initial = await prisma.deploymentLog.findMany({
      where: { deploymentId: dep.id },
      orderBy: { lineNo: "desc" },
      take: 500,
      select: { lineNo: true, text: true, stream: true, ts: true },
    });
    for (const row of initial.reverse()) {
      send(ws, "log", {
        lineNo: row.lineNo,
        text: row.text,
        stream: row.stream,
        ts: row.ts.toISOString(),
      });
      if (row.lineNo > state.lastLine) state.lastLine = row.lineNo;
    }
  }
  send(ws, "ready", { lastLine: state.lastLine });

  state.pingHandle = setInterval(() => {
    if (!state.alive) {
      try { ws.terminate(); } catch { /* noop */ }
      clearInterval(state.pingHandle);
      clearInterval(state.pollHandle);
      return;
    }
    state.alive = false;
    try { ws.ping(); } catch { /* noop */ }
  }, PING_MS);

  state.pollHandle = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(state.pollHandle);
      clearInterval(state.pingHandle);
      return;
    }
    try {
      const newRows = await prisma.deploymentLog.findMany({
        where: { deploymentId: state.deploymentId, lineNo: { gt: state.lastLine } },
        orderBy: { lineNo: "asc" },
        take: 1000,
        select: { lineNo: true, text: true, stream: true, ts: true },
      });
      for (const row of newRows) {
        send(ws, "log", {
          lineNo: row.lineNo,
          text: row.text,
          stream: row.stream,
          ts: row.ts.toISOString(),
        });
        state.lastLine = row.lineNo;
      }

      const cur = await prisma.deployment.findUnique({
        where: { id: state.deploymentId },
        select: { status: true },
      });
      if (
        cur &&
        TERMINAL_STATUSES.includes(cur.status as (typeof TERMINAL_STATUSES)[number]) &&
        cur.status !== "running"
      ) {
        send(ws, "done", { status: cur.status });
        clearInterval(state.pollHandle);
        clearInterval(state.pingHandle);
        try { ws.close(1000, "done"); } catch { /* noop */ }
      }
    } catch (e) {
      send(ws, "error", { code: "poll_failed", message: (e as Error).message });
    }
  }, POLL_MS);

  ws.on("pong", () => { state.alive = true; });

  ws.on("close", () => {
    clearInterval(state.pollHandle);
    clearInterval(state.pingHandle);
  });
}

export function startWsLogServer(): void {
  const port = config.wsLogsPort;
  if (!port || port <= 0) {
    console.log("[ws-logs] disabled (DEPLOYER_WS_LOGS_PORT=0)");
    return;
  }

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Upgrade required: this is a WebSocket endpoint. Connect with ws(s)://<host>/v1/agents/<entityId>/logs\n");
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const parsed = parsePath(req.url);
    if (!parsed) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      streamLogs(ws, parsed.entityId, parsed.after).catch((e) => {
        try {
          send(ws, "error", { code: "internal", message: (e as Error).message });
          ws.close(1011, "internal");
        } catch {
          // noop
        }
      });
    });
  });

  httpServer.listen(port, () => {
    console.log(`[ws-logs] listening on :${port} (path /v1/agents/<entityId>/logs)`);
  });
}
