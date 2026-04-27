// Python RuntimeSpec for the worker.
//
// Extracted from the former hard-coded paths in worker/docker.ts and
// worker/lifecycle.ts. Zero behaviour change for Python deployments.

import { config } from "@/lib/config";
import type { RuntimeSpec } from "@/lib/runtime";

export const pythonWorkerRuntime: Pick<
  RuntimeSpec,
  "baseImage" | "startCmd" | "envVarKeypairPath"
> = {
  baseImage: (e) =>
    e === "service" ? config.serviceBaseImage : config.agentBaseImage,

  startCmd: (e) => ["python", `/app/${e}.py`],

  envVarKeypairPath: (e) =>
    e === "service" ? "ZYND_SERVICE_KEYPAIR_PATH" : "ZYND_AGENT_KEYPAIR_PATH",
};
