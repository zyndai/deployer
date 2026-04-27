// Upload validator. Runs on the server before we persist anything.
//
// Rules live in one place so the API route and (optional) client-side
// pre-check can share them.
//
// See PLAN.md §5.

import JSZip from "jszip";

import type { EntityType, Keypair, ProjectConfig, Runtime } from "./types";
import { detectRuntime } from "./detect";
import { RUNTIMES } from "./runtime";

export const MAX_ZIP_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024; // 200MB

// A few file/path fragments that should never appear in an upload. The
// developer key is a hard reject; the other names are there so we catch
// people who zipped their whole `~/.zynd` folder by accident.
const FORBIDDEN_PATH_FRAGMENTS = [
  "developer.json",
  "/.zynd/developer/",
  ".zynd/developer/",
];

const FORBIDDEN_ENV_KEYS = [
  // Developer-key-ish names. Users should never ship these to the
  // deployer; the agent key alone is enough.
  "ZYND_DEVELOPER_PRIVATE_KEY",
  "ZYND_DEVELOPER_SEED",
];

export interface ValidationResult {
  entityType: EntityType;
  runtime: Runtime;
  config: ProjectConfig;
  keypair: Keypair;
  envText: string | null;                  // original .env file contents (may be null)
  requirementsText: string | null;         // original requirements.txt (may be null; only for python)
  projectFiles: Map<string, Uint8Array>;   // relative path -> bytes, stripped of forbidden entries
}

function assertNoForbiddenPaths(paths: string[]): void {
  for (const p of paths) {
    const normalised = p.replace(/\\/g, "/");
    for (const frag of FORBIDDEN_PATH_FRAGMENTS) {
      if (normalised.includes(frag)) {
        throw new Error(
          `Upload contains forbidden path "${p}". Developer keys must never be uploaded.`
        );
      }
    }
    if (normalised.startsWith("/") || normalised.includes("..")) {
      throw new Error(`Upload contains unsafe path: ${p}`);
    }
  }
}

function parseKeypair(raw: Buffer): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new Error(`keypair.json is not valid JSON: ${(e as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).public_key !== "string" ||
    typeof (parsed as Record<string, unknown>).private_key !== "string"
  ) {
    throw new Error(
      "keypair.json must be an object with base64 `public_key` and `private_key` fields"
    );
  }
  const kp = parsed as Keypair;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(kp.public_key)) {
    throw new Error("keypair.json public_key does not look like base64");
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(kp.private_key)) {
    throw new Error("keypair.json private_key does not look like base64");
  }
  return kp;
}

function sanityCheckEnv(text: string): void {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (FORBIDDEN_ENV_KEYS.includes(key)) {
      throw new Error(
        `Upload .env contains forbidden key ${key}. Remove it before deploying.`
      );
    }
  }
}

export async function validateUpload(
  projectZip: Buffer,
  keypairRaw: Buffer
): Promise<ValidationResult> {
  if (projectZip.length > MAX_ZIP_BYTES) {
    throw new Error(
      `project.zip exceeds ${MAX_ZIP_BYTES} bytes (got ${projectZip.length})`
    );
  }

  const keypair = parseKeypair(keypairRaw);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(projectZip);
  } catch (e) {
    throw new Error(`project.zip is not a valid zip file: ${(e as Error).message}`);
  }

  // Collect file paths first so we can sanity-check before doing any I/O.
  const allPaths: string[] = [];
  zip.forEach((p) => allPaths.push(p));
  assertNoForbiddenPaths(allPaths);

  // Detect a single leading-directory wrapper ("my-agent/agent.py") so
  // we don't force users to `cd` before zipping.
  const topLevelFolders = new Set<string>();
  for (const p of allPaths) {
    const seg = p.split("/")[0];
    if (seg) topLevelFolders.add(seg);
  }

  let strip = "";
  if (
    topLevelFolders.size === 1 &&
    allPaths.every((p) => p.includes("/") || p.endsWith("/"))
  ) {
    strip = `${Array.from(topLevelFolders)[0]}/`;
  }

  const projectFiles = new Map<string, Uint8Array>();
  let decompressed = 0;

  const entries = zip.filter((relativePath, file) => {
    if (file.dir) return false;
    const rel = strip && relativePath.startsWith(strip)
      ? relativePath.slice(strip.length)
      : relativePath;
    if (!rel) return false;
    if (rel.startsWith(".git/")) return false;
    if (rel.startsWith(".venv/") || rel.startsWith("node_modules/")) return false;
    return true;
  });

  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    decompressed += bytes.byteLength;
    if (decompressed > MAX_DECOMPRESSED_BYTES) {
      throw new Error(
        `Decompressed size exceeds ${MAX_DECOMPRESSED_BYTES} bytes (zip bomb guard)`
      );
    }
    const rel = strip && entry.name.startsWith(strip)
      ? entry.name.slice(strip.length)
      : entry.name;
    projectFiles.set(rel, bytes);
  }

  const hasAgentConfig = projectFiles.has("agent.config.json");
  const hasServiceConfig = projectFiles.has("service.config.json");

  if (hasAgentConfig === hasServiceConfig) {
    throw new Error(
      `project.zip must contain exactly one of agent.config.json or service.config.json at the root (found: agent=${hasAgentConfig}, service=${hasServiceConfig})`
    );
  }

  const entityType: EntityType = hasAgentConfig ? "agent" : "service";
  const configFile = hasAgentConfig ? "agent.config.json" : "service.config.json";

  // --- Detect runtime (language) ----------------------------------------
  const runtime = detectRuntime(projectFiles);
  const runtimeSpec = RUNTIMES[runtime];

  // --- Runtime-specific deep validation ---------------------------------
  await runtimeSpec.validate({ files: projectFiles, entityType });

  // --- Parse config JSON ------------------------------------------------
  let config: ProjectConfig;
  try {
    config = JSON.parse(
      Buffer.from(projectFiles.get(configFile)!).toString("utf8")
    );
  } catch (e) {
    throw new Error(`${configFile} is not valid JSON: ${(e as Error).message}`);
  }
  if (!config.name || typeof config.name !== "string") {
    throw new Error(`${configFile} must have a string "name" field`);
  }

  // .env is optional but if present must not contain developer keys.
  let envText: string | null = null;
  if (projectFiles.has(".env")) {
    envText = Buffer.from(projectFiles.get(".env")!).toString("utf8");
    sanityCheckEnv(envText);
  }

  // requirements.txt is only relevant for Python — the per-runtime
  // validate() already enforces line-count limits.
  let requirementsText: string | null = null;
  if (runtime === "python" && projectFiles.has("requirements.txt")) {
    requirementsText = Buffer.from(
      projectFiles.get("requirements.txt")!
    ).toString("utf8");
  }

  return {
    entityType,
    runtime,
    config,
    keypair,
    envText,
    requirementsText,
    projectFiles,
  };
}
