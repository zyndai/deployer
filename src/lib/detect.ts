// detectRuntime — determine "python" | "node" from the files in an upload.
//
// Priority (per design §7 risk 1):
//   1. Explicit `language` field in *.config.json wins over file heuristics.
//   2. Presence of agent.py / service.py → python.
//   3. package.json with dependencies.zyndai + agent.ts/service.ts → node.
//   4. Ambiguous or unrecognisable → throws with a clear error.

import type { Runtime } from "./types";

export function detectRuntime(files: Map<string, Uint8Array>): Runtime {
  // --- 1. Read explicit language from config file -----------------------

  const configFile = files.has("agent.config.json")
    ? "agent.config.json"
    : files.has("service.config.json")
      ? "service.config.json"
      : null;

  if (configFile) {
    try {
      const raw = JSON.parse(
        Buffer.from(files.get(configFile)!).toString("utf8")
      ) as Record<string, unknown>;
      if (raw.language === "ts" || raw.language === "js") {
        return "node";
      }
      if (raw.language === "python" || raw.language === "py") {
        return "python";
      }
      // language field absent or unrecognised — fall through to heuristics
    } catch {
      // unparseable config — fall through; validator will reject it properly
    }
  }

  // --- 2. Heuristics ---------------------------------------------------

  const hasPy = files.has("agent.py") || files.has("service.py");

  let hasNode = false;
  if (files.has("package.json")) {
    try {
      const pkg = JSON.parse(
        Buffer.from(files.get("package.json")!).toString("utf8")
      ) as Record<string, unknown>;
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      const hasZyndai = deps && typeof deps === "object" && "zyndai" in deps;
      const hasEntryTs =
        files.has("agent.ts") ||
        files.has("service.ts") ||
        files.has("agent.js") ||
        files.has("service.js");
      hasNode = Boolean(hasZyndai && hasEntryTs);
    } catch {
      // malformed package.json — treat as non-node
    }
  }

  if (hasPy && hasNode) {
    throw new Error(
      "Ambiguous upload: contains both Python entry files (agent.py / service.py) and " +
        "a Node.js package.json with zyndai + TS/JS entry. " +
        'Add a "language" field to your *.config.json to disambiguate, ' +
        'or remove the conflicting files. Accepted values: "ts" | "python".'
    );
  }

  if (hasPy) return "python";
  if (hasNode) return "node";

  throw new Error(
    "Could not detect runtime. Upload must contain either:\n" +
      "  Python: agent.py or service.py\n" +
      "  Node.js: package.json (with dependencies.zyndai) + agent.ts or service.ts"
  );
}
