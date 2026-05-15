import { type NextRequest } from "next/server";
import { proxyToContainer } from "@/lib/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string; path?: string[] }> };

async function handler(req: NextRequest, { params }: Ctx) {
  const { slug, path } = await params;
  return proxyToContainer(req, slug, path ?? []);
}

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
