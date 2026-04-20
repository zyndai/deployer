// POST /api/deployments   — create a new deployment from an upload
// GET  /api/deployments   — list deployments (newest first)

import { NextResponse } from "next/server";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { prisma } from "@/lib/db";
import { encryptToFile } from "@/lib/crypto";
import { validateUpload } from "@/lib/validator";
import { uniqueSlug } from "@/lib/slug";
import { config, paths } from "@/lib/config";
import { ACTIVE_STATUSES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- GET ----------------------------------------------------------------

export async function GET() {
  const rows = await prisma.deployment.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      entityType: true,
      entityId: true,
      status: true,
      errorMessage: true,
      hostUrl: true,
      port: true,
      publicKeyB64: true,
      lastExitCode: true,
      lastCrashAt: true,
      createdAt: true,
      startedAt: true,
      stoppedAt: true,
    },
  });
  return NextResponse.json({ deployments: rows });
}

// --- POST ---------------------------------------------------------------

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return NextResponse.json(
      { error: "Content-Type must be multipart/form-data" },
      { status: 400 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: `Could not parse multipart body: ${(e as Error).message}` },
      { status: 400 }
    );
  }

  const zipPart = form.get("project.zip");
  const keyPart = form.get("keypair.json");
  if (!(zipPart instanceof Blob) || !(keyPart instanceof Blob)) {
    return NextResponse.json(
      { error: "Both project.zip and keypair.json are required form fields" },
      { status: 400 }
    );
  }

  const zipBuf = Buffer.from(await zipPart.arrayBuffer());
  const keyBuf = Buffer.from(await keyPart.arrayBuffer());

  // --- Validate --------------------------------------------------------

  let parsed;
  try {
    parsed = await validateUpload(zipBuf, keyBuf);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 400 }
    );
  }

  // --- Enforce soft cap on concurrent deployments ---------------------

  const activeCount = await prisma.deployment.count({
    where: { status: { in: ACTIVE_STATUSES } },
  });
  if (activeCount >= config.maxActive) {
    return NextResponse.json(
      {
        error: `Deployer is at capacity (${activeCount}/${config.maxActive}). Stop an old deployment first.`,
      },
      { status: 503 }
    );
  }

  // --- Allocate slug + id ---------------------------------------------

  const slug = uniqueSlug(parsed.config.name, parsed.entityType);

  // Very unlikely but still cheaper than handling a unique-constraint
  // blow-up from the ORM.
  const slugExists = await prisma.deployment.findUnique({ where: { slug } });
  if (slugExists) {
    return NextResponse.json(
      { error: `Slug collision on ${slug}; retry the upload.` },
      { status: 409 }
    );
  }

  // --- Persist blobs on disk (age-encrypted) --------------------------

  // Use a stable id we control so the blob path is known before the DB
  // insert. cuid() would also work, but we like predictable filenames.
  const id = crypto.randomUUID();

  const blobDir = join(paths.blobs);
  const keyDir = join(paths.keys, id);
  await mkdir(blobDir, { recursive: true });
  await mkdir(keyDir, { recursive: true });

  const blobPath = join(blobDir, `${id}.zip.age`);
  const keyPath = join(keyDir, `keypair.json.age`);

  try {
    await encryptToFile(zipBuf, blobPath);
    await encryptToFile(keyBuf, keyPath);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to encrypt upload: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  // --- Insert deployment row ------------------------------------------

  try {
    const dep = await prisma.deployment.create({
      data: {
        id,
        name: parsed.config.name,
        slug,
        entityType: parsed.entityType,
        registryUrl: config.registryUrl,
        status: "queued",
        blobPath,
        keyPath,
        publicKeyB64: parsed.keypair.public_key,
      },
      select: { id: true, slug: true, status: true },
    });

    return NextResponse.json(dep, { status: 201 });
  } catch (e) {
    // If the DB insert failed after we wrote the encrypted files, leave
    // them in place for the operator to clean up; better than trying to
    // fs.unlink in a stale state.
    return NextResponse.json(
      { error: `Failed to persist deployment: ${(e as Error).message}` },
      { status: 500 }
    );
  }
}
