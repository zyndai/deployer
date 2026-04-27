// Node.js RuntimeSpec for the worker.
//
// Entry-file resolution order matches what `zynd agent run` does locally:
// agent.ts -> agent.js -> agent.mjs -> agent.cjs
// The start command always passes tsx as the runner; if the user shipped
// a pre-compiled .js the entrypoint-node.sh script can be updated later
// to detect and prefer it. For Slice 1 tsx is always used.

import type { RuntimeSpec } from "@/lib/runtime";

const NODE_AGENT_BASE_IMAGE =
  process.env.NODE_AGENT_BASE_IMAGE ?? "zynd-deployer/node-agent-base:latest";
const NODE_SERVICE_BASE_IMAGE =
  process.env.NODE_SERVICE_BASE_IMAGE ?? "zynd-deployer/node-service-base:latest";

export const nodeWorkerRuntime: Pick<
  RuntimeSpec,
  "baseImage" | "startCmd" | "envVarKeypairPath"
> = {
  baseImage: (e) =>
    e === "service" ? NODE_SERVICE_BASE_IMAGE : NODE_AGENT_BASE_IMAGE,

  // tsx lives in the base image at /opt/zynd-base/node_modules/.bin/tsx.
  // We invoke it via `node <path-to-tsx-bin>` so Node resolves it from the
  // pre-installed base layer rather than relying on PATH.
  startCmd: (e) => [
    "node",
    "/opt/zynd-base/node_modules/.bin/tsx",
    `/app/${e}.ts`,
  ],

  envVarKeypairPath: (e) =>
    e === "service" ? "ZYND_SERVICE_KEYPAIR_PATH" : "ZYND_AGENT_KEYPAIR_PATH",
};
