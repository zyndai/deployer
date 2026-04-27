// Runtime strategy interface + registry.
//
// Each Runtime describes the language-specific surface that the validator
// and worker need. Everything else in the pipeline (port allocation, Caddy,
// log tailing, health probing, crash watching) is runtime-agnostic and stays
// in the generic lifecycle / docker modules.

import type { EntityType, Runtime as RuntimeId } from "./types";

// Per-validation context handed to Runtime.validate.
export interface ValidationCtx {
  files: Map<string, Uint8Array>;
  entityType: EntityType;
}

export interface RuntimeValidation {
  ok: true;
  packageJsonText?: string | null; // node: raw package.json text (may be needed for dep list)
}

// Rewrite context handed to Runtime.rewriteConfigJson if it chooses to
// override the default *.config.json rewrite logic.
export interface RewriteCtx {
  webhookPort: number;
  registryUrl: string;
  keypairPath: string;
}

export interface RuntimeSpec {
  id: RuntimeId;
  label: string;
  /** config filename for this entity type */
  configFile: (e: EntityType) => string;
  /** canonical entry-point filename for this entity type */
  entryFile: (e: EntityType) => string;
  /** heuristic detect — used only by detectRuntime, not by the worker */
  detect: (files: Map<string, Uint8Array>) => boolean;
  /** runtime-specific deep validation; throws on failure */
  validate: (ctx: ValidationCtx) => Promise<RuntimeValidation>;
  /** docker image name for this entity type */
  baseImage: (e: EntityType) => string;
  /** command array passed as Cmd to docker.createContainer */
  startCmd: (e: EntityType) => string[];
  /** env-var name that holds the keypair path inside the container */
  envVarKeypairPath: (e: EntityType) => string;
  /** optional override of *.config.json rewrite logic */
  rewriteConfigJson?: (raw: Record<string, unknown>, ctx: RewriteCtx) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Python runtime
// ---------------------------------------------------------------------------

const MAX_REQUIREMENTS_LINES = 200;

const pythonRuntime: RuntimeSpec = {
  id: "python",
  label: "Python",

  configFile: (e) => `${e}.config.json`,
  entryFile: (e) => `${e}.py`,

  detect: (files) => {
    return files.has("agent.py") || files.has("service.py");
  },

  validate: async (ctx) => {
    const { files, entityType } = ctx;
    const scriptFile = `${entityType}.py`;
    if (!files.has(scriptFile)) {
      throw new Error(`project.zip must contain ${scriptFile} at the root`);
    }
    // requirements.txt line-count cap (mirrors the rule that was inline
    // in validator.ts before the Runtime abstraction).
    if (files.has("requirements.txt")) {
      const text = Buffer.from(files.get("requirements.txt")!).toString("utf8");
      const nonEmpty = text
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith("#"));
      if (nonEmpty.length > MAX_REQUIREMENTS_LINES) {
        throw new Error(
          `requirements.txt has ${nonEmpty.length} dependency lines, max is ${MAX_REQUIREMENTS_LINES}`
        );
      }
    }
    return { ok: true };
  },

  baseImage: (e) =>
    e === "service"
      ? (process.env.SERVICE_BASE_IMAGE ?? "zynd-deployer/service-base:latest")
      : (process.env.AGENT_BASE_IMAGE ?? "zynd-deployer/agent-base:latest"),

  startCmd: (e) => ["python", `/app/${e}.py`],

  envVarKeypairPath: (e) =>
    e === "service" ? "ZYND_SERVICE_KEYPAIR_PATH" : "ZYND_AGENT_KEYPAIR_PATH",
};

// ---------------------------------------------------------------------------
// Node.js runtime
// ---------------------------------------------------------------------------

const MAX_DIRECT_DEPS = 100;

const nodeRuntime: RuntimeSpec = {
  id: "node",
  label: "Node.js",

  configFile: (e) => `${e}.config.json`,
  entryFile: (e) => `${e}.ts`,

  detect: (files) => {
    if (!files.has("package.json")) return false;
    try {
      const pkg = JSON.parse(
        Buffer.from(files.get("package.json")!).toString("utf8")
      ) as Record<string, unknown>;
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      if (!deps || typeof deps !== "object" || !("zyndai" in deps)) return false;
    } catch {
      return false;
    }
    return files.has("agent.ts") || files.has("service.ts") ||
           files.has("agent.js") || files.has("service.js");
  },

  validate: async (ctx) => {
    const { files, entityType } = ctx;

    // Must have package.json with zyndai dependency.
    if (!files.has("package.json")) {
      throw new Error("Node.js project must contain package.json at the root");
    }

    let pkg: Record<string, unknown>;
    const pkgText = Buffer.from(files.get("package.json")!).toString("utf8");
    try {
      pkg = JSON.parse(pkgText) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`package.json is not valid JSON: ${(e as Error).message}`);
    }

    const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
    if (!deps || typeof deps !== "object" || !("zyndai" in deps)) {
      throw new Error(
        'package.json must list "zyndai" in dependencies. ' +
        'Run `npm install zyndai` inside your project first.'
      );
    }

    // Cap direct dep count (dependencies only — devDependencies are stripped
    // at install time via --omit=dev).
    const depCount = Object.keys(deps).length;
    if (depCount > MAX_DIRECT_DEPS) {
      throw new Error(
        `package.json has ${depCount} direct dependencies, max is ${MAX_DIRECT_DEPS}`
      );
    }

    // Reject workspace:* references that npm can't resolve outside a monorepo.
    const allDepValues = [
      ...Object.values(deps),
      ...Object.values((pkg.devDependencies ?? {}) as Record<string, unknown>),
    ];
    for (const v of allDepValues) {
      if (typeof v === "string" && v.startsWith("workspace:")) {
        throw new Error(
          'package.json contains workspace: dep specifiers. ' +
          'Flatten your project before deploying (remove the monorepo workspace references).'
        );
      }
    }

    // Reject node_modules/ in upload — the user must not ship their own
    // install; the entrypoint runs npm install inside the container.
    for (const path of files.keys()) {
      if (path.startsWith("node_modules/") || path.includes("/node_modules/")) {
        throw new Error(
          "Upload must not contain a node_modules/ directory. " +
          "Delete it and re-zip the project folder."
        );
      }
    }

    // Reject .npmrc files that contain auth tokens.
    if (files.has(".npmrc")) {
      const npmrc = Buffer.from(files.get(".npmrc")!).toString("utf8");
      if (/_authToken|:_auth\b|\/\/[^:]*:_password/.test(npmrc)) {
        throw new Error(
          ".npmrc contains an auth token. Remove registry auth from .npmrc before deploying."
        );
      }
    }

    // Must have a recognised entry file.
    const hasEntry =
      files.has(`${entityType}.ts`) ||
      files.has(`${entityType}.js`) ||
      files.has(`${entityType}.mjs`) ||
      files.has(`${entityType}.cjs`);
    if (!hasEntry) {
      throw new Error(
        `Node.js ${entityType} project must contain ${entityType}.ts (or .js/.mjs/.cjs) at the root`
      );
    }

    return { ok: true, packageJsonText: pkgText };
  },

  baseImage: (e) =>
    e === "service"
      ? (process.env.NODE_SERVICE_BASE_IMAGE ?? "zynd-deployer/node-service-base:latest")
      : (process.env.NODE_AGENT_BASE_IMAGE ?? "zynd-deployer/node-agent-base:latest"),

  startCmd: (e) => {
    // Prefer compiled JS if present (detected at container start via entrypoint),
    // but the default CMD always points at the .ts entry; the entrypoint script
    // chooses tsx vs node based on what it finds at /app.
    return ["node", "/opt/zynd-base/node_modules/.bin/tsx", `/app/${e}.ts`];
  },

  envVarKeypairPath: (e) =>
    e === "service" ? "ZYND_SERVICE_KEYPAIR_PATH" : "ZYND_AGENT_KEYPAIR_PATH",
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const RUNTIMES: Record<RuntimeId, RuntimeSpec> = {
  python: pythonRuntime,
  node: nodeRuntime,
};
