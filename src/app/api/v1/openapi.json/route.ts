// GET /api/v1/openapi.json
//
// Hand-maintained OpenAPI 3.1 spec for the public deployer API. Served
// as JSON so the /docs page (Swagger UI from CDN) can render it.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(spec);
}

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Zynd Deployer API",
    version: "1.0.0",
    description:
      "Programmatic interface for uploading, listing, and tailing logs of " +
      "agents and services hosted on the deployer. Mirrors what the web UI does.",
  },
  servers: [{ url: "/", description: "current host" }],
  tags: [
    { name: "deployments", description: "Create / list / detail / stop" },
    { name: "logs", description: "Read and stream container logs" },
  ],
  paths: {
    "/api/deployments": {
      get: {
        tags: ["deployments"],
        summary: "List deployments (newest first)",
        responses: {
          "200": {
            description: "Array of deployments",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deployments: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Deployment" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["deployments"],
        summary: "Upload a project + keypair and create a deployment",
        description:
          "Multipart upload. The project zip must contain either an " +
          "`agent.{py,ts,js}` or `service.{py,ts,js}` plus the matching " +
          "`*.config.json`. The keypair is the JSON file produced by the " +
          "Zynd CLI's `keygen` command. Both are encrypted at rest with " +
          "the deployer's master age identity.",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["project.zip", "keypair.json"],
                properties: {
                  "project.zip": {
                    type: "string",
                    format: "binary",
                    description: "Zip of the project directory.",
                  },
                  "keypair.json": {
                    type: "string",
                    format: "binary",
                    description:
                      'JSON like `{"public_key":"...","private_key":"..."}`.',
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Deployment queued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    slug: { type: "string" },
                    status: { type: "string" },
                    runtime: { type: "string", enum: ["python", "node"] },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid upload" },
          "503": { description: "Deployer at capacity" },
        },
      },
    },
    "/api/deployments/{id}": {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        tags: ["deployments"],
        summary: "Get deployment detail",
        responses: {
          "200": {
            description: "Deployment row",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Deployment" },
              },
            },
          },
          "404": { description: "Not found" },
        },
      },
      delete: {
        tags: ["deployments"],
        summary: "Mark deployment for stop",
        description:
          "Idempotent. The worker reconciles the actual container shutdown " +
          "and Caddy route removal asynchronously.",
        responses: { "200": { description: "Stopped" } },
      },
    },
    "/api/deployments/{id}/logs": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "after",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
          description: "Return only lines with lineNo > this value.",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
        },
      ],
      get: {
        tags: ["logs"],
        summary: "Paginated log read by deployment id",
        responses: {
          "200": {
            description: "Log lines",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    lines: {
                      type: "array",
                      items: { $ref: "#/components/schemas/LogLine" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/deployments/{id}/logs/stream": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        tags: ["logs"],
        summary: "Server-Sent Events live tail by deployment id",
        description:
          "Emits `log`, `ready`, `done`, and `error` events. " +
          "Connect with an EventSource client.",
        responses: {
          "200": {
            description: "text/event-stream",
            content: { "text/event-stream": {} },
          },
        },
      },
    },
    "/api/v1/agents/{entityId}/logs": {
      parameters: [
        {
          name: "entityId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description:
            "The registry entity id reported by the agent's " +
            "`/.well-known/agent.json`.",
        },
        { name: "after", in: "query", schema: { type: "integer", default: 0 } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 2000, default: 500 },
        },
      ],
      get: {
        tags: ["logs"],
        summary: "Paginated log read by entity_id",
        responses: {
          "200": {
            description: "Log lines",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    deploymentId: { type: "string" },
                    status: { type: "string" },
                    lines: {
                      type: "array",
                      items: { $ref: "#/components/schemas/LogLine" },
                    },
                  },
                },
              },
            },
          },
          "404": { description: "No deployment for this entity_id" },
        },
      },
    },
    "/api/v1/agents/{entityId}/logs/stream": {
      parameters: [
        {
          name: "entityId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        tags: ["logs"],
        summary: "Server-Sent Events live tail by entity_id",
        responses: {
          "200": {
            description: "text/event-stream",
            content: { "text/event-stream": {} },
          },
          "404": { description: "No deployment for this entity_id" },
        },
      },
    },
  },
  components: {
    schemas: {
      Deployment: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          slug: { type: "string" },
          entityType: { type: "string", enum: ["agent", "service"] },
          entityId: { type: ["string", "null"] },
          registryUrl: { type: "string" },
          status: { type: "string" },
          errorMessage: { type: ["string", "null"] },
          port: { type: ["integer", "null"] },
          containerId: { type: ["string", "null"] },
          hostUrl: { type: ["string", "null"] },
          publicKeyB64: { type: ["string", "null"] },
          lastExitCode: { type: ["integer", "null"] },
          lastCrashAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          startedAt: { type: ["string", "null"], format: "date-time" },
          stoppedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      LogLine: {
        type: "object",
        properties: {
          lineNo: { type: "integer" },
          text: { type: "string" },
          stream: { type: "string", enum: ["stdout", "stderr", "system"] },
          ts: { type: "string", format: "date-time" },
        },
      },
    },
  },
  "x-websocket": {
    description:
      "A live log tail is also exposed over WebSocket on the worker " +
      "process, separate from the Next.js server (Next App Router cannot " +
      "upgrade requests to WebSockets). Default port 7071, override with " +
      "DEPLOYER_WS_LOGS_PORT.",
    url: "ws://<deployer-host>:7071/v1/agents/<entityId>/logs",
    queryParams: {
      after: "Optional lineNo cursor — only emit lines strictly greater than this.",
    },
    messages: [
      { type: "hello", payload: "{ deploymentId, entityId, status }" },
      { type: "ready", payload: "{ lastLine }" },
      { type: "log", payload: "{ lineNo, text, stream, ts }" },
      { type: "done", payload: "{ status } — emitted on terminal status" },
      { type: "error", payload: "{ code, message }" },
    ],
  },
};
