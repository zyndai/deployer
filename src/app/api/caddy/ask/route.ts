import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { config } from "@/lib/config";

// Caddy on_demand_tls "ask" hook. Caddy calls this before issuing a LE
// cert for an unknown host. Return 2xx iff we recognise the slug as a
// deployment — otherwise strangers could make Caddy burn our weekly
// Let's Encrypt rate limit on random subdomains.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const host = url.searchParams.get("domain");
  if (!host) return new NextResponse("missing domain", { status: 400 });

  const suffix = `.${config.wildcardDomain}`;
  if (!host.endsWith(suffix)) {
    return new NextResponse("not our zone", { status: 404 });
  }
  const slug = host.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) {
    return new NextResponse("invalid slug", { status: 404 });
  }

  const hit = await prisma.deployment.findFirst({
    where: { slug },
    select: { id: true },
  });
  return hit
    ? new NextResponse("ok", { status: 200 })
    : new NextResponse("unknown slug", { status: 404 });
}
