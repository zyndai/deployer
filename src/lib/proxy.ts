import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export async function proxyToContainer(
  req: NextRequest,
  slug: string,
  pathSegments: string[]
): Promise<Response> {
  let dep: { port: number | null; status: string } | null;
  try {
    dep = await prisma.deployment.findUnique({
      where: { slug },
      select: { port: true, status: true },
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  if (!dep || dep.port === null) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (dep.status !== "running" && dep.status !== "unhealthy") {
    return NextResponse.json(
      { error: `Deployment is ${dep.status}` },
      { status: 503 }
    );
  }

  const upstreamPath =
    pathSegments.length > 0 ? `/${pathSegments.join("/")}` : "/";
  const upstreamUrl = `http://127.0.0.1:${dep.port}${upstreamPath}${req.nextUrl.search}`;

  const forwardHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  });

  let upstreamRes: Response;
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error — Node 18+ fetch needs duplex for streaming request bodies
      duplex: hasBody ? "half" : undefined,
      signal: req.signal,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Upstream unreachable: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  const resHeaders = new Headers();
  upstreamRes.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      resHeaders.set(key, value);
    }
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: resHeaders,
  });
}
