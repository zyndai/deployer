// Live log tailer. Spawns one `docker logs -f` stream per running
// container and inserts each emitted line into DeploymentLog.
//
// The tailer tracks its own lineNo counter per deployment so we don't
// round-trip the DB for each line.

import { PassThrough } from "node:stream";

import { docker } from "./docker";
import { prisma } from "@/lib/db";

const active = new Map<string, { abort: AbortController; nextLine: number }>();

/**
 * Postgres text columns reject \0 (error 22021) even though UTF-8
 * allows them. Any upstream that hands us raw bytes from a docker
 * stream, a corrupted build, etc. could leak one through — replace
 * with the Unicode replacement character so the insert always succeeds.
 */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u0000/g, "\uFFFD");
}

async function currentLineNo(deploymentId: string): Promise<number> {
  const last = await prisma.deploymentLog.findFirst({
    where: { deploymentId },
    orderBy: { lineNo: "desc" },
    select: { lineNo: true },
  });
  return last?.lineNo ?? 0;
}

export async function startTailer(
  deploymentId: string,
  containerId: string
): Promise<void> {
  if (active.has(deploymentId)) return;

  const abort = new AbortController();
  const nextLine = (await currentLineNo(deploymentId)) + 1;
  const state = { abort, nextLine };
  active.set(deploymentId, state);

  const c = docker.getContainer(containerId);
  const stream = await c.logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail: 0,
    timestamps: false,
  });

  // The docker socket multiplexes stdout/stderr using an 8-byte header
  // per frame (stream type + 4-byte payload length). `demuxStream` is a
  // helper on the dockerode Docker instance.
  const stdoutPT = new PassThrough();
  const stderrPT = new PassThrough();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (docker as any).modem.demuxStream(stream, stdoutPT, stderrPT);

  const writeLine = async (text: string, streamName: "stdout" | "stderr") => {
    if (!text) return;
    const lineNo = state.nextLine++;
    try {
      await prisma.deploymentLog.create({
        data: { deploymentId, lineNo, text: sanitize(text), stream: streamName },
      });
    } catch {
      // swallow — we don't want a single DB hiccup to kill the tail
    }
  };

  const attach = (pt: NodeJS.ReadableStream, streamName: "stdout" | "stderr") => {
    let buf = "";
    pt.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.length > 0) void writeLine(line, streamName);
      }
    });
    pt.on("end", () => {
      if (buf.length > 0) void writeLine(buf, streamName);
    });
  };

  attach(stdoutPT, "stdout");
  attach(stderrPT, "stderr");

  abort.signal.addEventListener("abort", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).destroy?.();
  });
}

export function stopTailer(deploymentId: string): void {
  const state = active.get(deploymentId);
  if (state) {
    state.abort.abort();
    active.delete(deploymentId);
  }
}

export async function appendSystemLog(
  deploymentId: string,
  text: string
): Promise<void> {
  const last = await currentLineNo(deploymentId);
  await prisma.deploymentLog.create({
    data: {
      deploymentId,
      lineNo: last + 1,
      text: sanitize(text),
      stream: "system",
    },
  });
}
