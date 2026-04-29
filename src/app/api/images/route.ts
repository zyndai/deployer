// GET /api/images
//
// Returns the set of Zynd-labelled container images available on the
// local Docker daemon, so the deploy UI can render an image picker
// scoped to the user's detected runtime + entity type.

import { NextResponse } from "next/server";

import { listZyndImages } from "@/lib/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const images = await listZyndImages();
    return NextResponse.json(
      { images },
      // Short cache: image set rarely changes; the deploy page refetches
      // on every navigation anyway.
      { headers: { "Cache-Control": "private, max-age=15" } }
    );
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to enumerate images: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
