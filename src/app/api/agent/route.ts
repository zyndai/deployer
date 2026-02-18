import { NextRequest, NextResponse } from "next/server";

const N8N_BASE = "https://test-n8n.zynd.ai";
const X_N8N_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NWZkN2M5Ny0yOThjLTQ3YTItYjQwZi1kYzYxMjJmZDNjNmEiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiNTAxYzMzNzYtODJkMS00MTU4LThlNjgtMGE3YzViOTYwZjdiIiwiaWF0IjoxNzcxMzkzNDMzLCJleHAiOjE3NzM5NzkyMDB9.xm3-bOy30LPOvN172K_Q9uHDlfSo4qTFFxMXjGXSwkY";

export async function GET(req: NextRequest) {
  try {
    const workflowId = req.nextUrl.searchParams.get("workflowId");

    if (!workflowId) {
      return NextResponse.json(
        { error: "workflowId query param is required" },
        { status: 400 }
      );
    }

    const res = await fetch(
      `${N8N_BASE}/api/v1/workflows/${workflowId}?excludePinnedData=true`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "X-N8N-API-KEY": X_N8N_API_KEY,
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return NextResponse.json(
        { error: "Failed to fetch workflow", details: errText },
        { status: res.status }
      );
    }

    const data = await res.json();

    // Find the X402 Webhook node to get webhookId
    const webhookNode = data.nodes?.find(
      (n: { type: string }) => n.type === "CUSTOM.zyndX402Webhook"
    );
    const webhookId = webhookNode?.webhookId || "";
    const webhookUrl = webhookId ? `${N8N_BASE}/webhook/${webhookId}/pay` : "";

    return NextResponse.json({
      workflowId: data.id,
      agentName: data.name,
      webhookId,
      webhookUrl,
      active: data.active,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    return NextResponse.json(
      { error: "Internal server error", details: message },
      { status: 500 }
    );
  }
}
