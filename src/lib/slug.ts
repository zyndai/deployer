// Slug generation matching the rules in zyndai-agent's slugify_name so the
// ZNS name we advertise on the registry matches what the user sees in the
// deployer UI.

import { randomBytes } from "node:crypto";

const SLUG_MAX = 36;

export function slugify(name: string, fallbackSuffix = ""): string {
  let slug = name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (slug.length < 3 && fallbackSuffix) {
    slug = `${slug}${fallbackSuffix}`;
  }
  if (slug.length > SLUG_MAX) {
    slug = slug.slice(0, SLUG_MAX);
  }
  return slug;
}

// Every deployment gets a short random suffix so the user can redeploy
// with the same name without having to wait for slug recycling. Keep the
// combined slug within the 63-char DNS label limit with plenty of margin.
export function uniqueSlug(name: string, entityType: "agent" | "service"): string {
  const suffix = entityType === "service" ? "-service" : "-agent";
  const base = slugify(name, suffix);
  const rand = randomBytes(3).toString("hex"); // 6 hex chars
  const combined = `${base}-${rand}`;
  return combined.length > 50 ? combined.slice(0, 50) : combined;
}
