// Image discovery for the deploy UI.
//
// Operators ship base images (and optional flavor images like
// zynd-deployer/agent-playwright) onto the host. We don't bake their
// Dockerfiles into this repo — we just read whichever images are
// present locally and surface them in the picker if they carry the
// right `zynd.*` labels.
//
// Required labels on every operator image:
//   zynd.runtime   = "python" | "node"
//   zynd.kind      = "agent"  | "service"
//   zynd.flavor    = "base"   | <freeform string, e.g. "playwright">
//   zynd.display   = human-readable dropdown label
//   zynd.description (optional) = one-line tooltip

import Docker from "dockerode";

import { config } from "./config";
import type { EntityType, Runtime } from "./types";

export interface ZyndImage {
  /** Full reference the worker will pass to docker run, e.g. "zynd-deployer/agent-base:latest". */
  ref: string;
  /** Image SHA — stable identity even if tags change. */
  id: string;
  runtime: Runtime;
  kind: EntityType;
  flavor: string;
  display: string;
  description: string | null;
}

let docker: Docker | null = null;

function client(): Docker {
  if (!docker) docker = new Docker({ socketPath: config.dockerSocket });
  return docker;
}

function pickRef(repoTags: string[] | undefined, repoDigests: string[] | undefined): string | null {
  // Prefer a human-readable repo:tag. Skip <none>:<none>.
  const tags = (repoTags ?? []).filter((t) => t && !t.startsWith("<none>"));
  if (tags.length > 0) {
    // Prefer :latest if present so the picker is stable across rebuilds.
    const latest = tags.find((t) => t.endsWith(":latest"));
    return latest ?? tags[0];
  }
  // Fall back to a digest-pinned ref so the worker can still run it.
  const digests = (repoDigests ?? []).filter((d) => d && !d.startsWith("<none>"));
  if (digests.length > 0) return digests[0];
  return null;
}

function isRuntime(v: unknown): v is Runtime {
  return v === "python" || v === "node";
}

function isEntity(v: unknown): v is EntityType {
  return v === "agent" || v === "service";
}

/**
 * Enumerate Zynd-labelled images on the local Docker daemon.
 * Filters images that lack any required label so the UI doesn't surface
 * half-built or mis-labelled images.
 */
export async function listZyndImages(): Promise<ZyndImage[]> {
  const raw = await client().listImages({
    filters: { label: ["zynd.runtime"] },
  });

  const out: ZyndImage[] = [];
  for (const img of raw) {
    const labels = (img.Labels ?? {}) as Record<string, string>;
    const runtime = labels["zynd.runtime"];
    const kind = labels["zynd.kind"];
    const flavor = labels["zynd.flavor"];
    const display = labels["zynd.display"];
    const description = labels["zynd.description"] ?? null;
    if (!isRuntime(runtime) || !isEntity(kind) || !flavor || !display) continue;

    const ref = pickRef(img.RepoTags, img.RepoDigests);
    if (!ref) continue;

    out.push({
      ref,
      id: img.Id,
      runtime,
      kind,
      flavor,
      display,
      description,
    });
  }

  // Stable sort: base flavor first, then alpha by display name. Picker
  // always lands on the base image when nothing is selected.
  out.sort((a, b) => {
    if (a.flavor === "base" && b.flavor !== "base") return -1;
    if (b.flavor === "base" && a.flavor !== "base") return 1;
    return a.display.localeCompare(b.display);
  });

  return out;
}

/**
 * Look up an image by its ref. Used by the deploy POST to confirm the
 * user-picked image still exists and matches the upload's runtime + kind.
 */
export async function findZyndImage(ref: string): Promise<ZyndImage | null> {
  const all = await listZyndImages();
  return all.find((i) => i.ref === ref) ?? null;
}
