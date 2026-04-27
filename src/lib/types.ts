// Shared types between Next.js route handlers, the worker, and the UI.

export type EntityType = "agent" | "service";

export type Runtime = "python" | "node";

export type DeploymentStatus =
  | "queued"
  | "unpacking"
  | "writing_config"
  | "allocating_port"
  | "building"
  | "starting"
  | "health_checking"
  | "registering_route"
  | "running"
  | "unhealthy"
  | "failed"
  | "stopped"
  | "crashed";

export const TERMINAL_STATUSES: DeploymentStatus[] = [
  "running",
  "unhealthy",
  "failed",
  "stopped",
  "crashed",
];

export const ACTIVE_STATUSES: DeploymentStatus[] = [
  "queued",
  "unpacking",
  "writing_config",
  "allocating_port",
  "building",
  "starting",
  "health_checking",
  "registering_route",
  "running",
  "unhealthy",
];

export interface Keypair {
  public_key: string;
  private_key: string;
}

// Canonical shape the SDK writes today (see
// zyndai-agent/zynd_cli/commands/service_cmd.py and agent_cmd.py).
export interface ProjectConfig {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  summary?: string;
  webhook_port?: number;
  entity_index?: number;
  entity_pricing?: unknown;
  // service-only
  service_endpoint?: string | null;
  openapi_url?: string | null;
  // Optional explicit override the user may have set locally.
  entity_name?: string;
}

export interface UploadResult {
  id: string;
  slug: string;
  status: DeploymentStatus;
  runtime: Runtime;
}

export interface LogLine {
  lineNo: number;
  text: string;
  stream: "stdout" | "stderr" | "system";
  ts: string;
}
