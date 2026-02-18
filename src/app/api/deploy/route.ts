import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";

const N8N_BASE = "https://test-n8n.zynd.ai";
const X_API_KEY =
  "zynd_3ae9793ff5c146f57b86d4c4fd7464f2865c60382f3e22da581dff8ab752c50c";
const X_N8N_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NWZkN2M5Ny0yOThjLTQ3YTItYjQwZi1kYzYxMjJmZDNjNmEiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiNTAxYzMzNzYtODJkMS00MTU4LThlNjgtMGE3YzViOTYwZjdiIiwiaWF0IjoxNzcxMzkzNDMzLCJleHAiOjE3NzM5NzkyMDB9.xm3-bOy30LPOvN172K_Q9uHDlfSo4qTFFxMXjGXSwkY";

export async function POST(req: NextRequest) {
  try {
    const { name, socialUrl, description } = await req.json();

    if (!name || !description) {
      return NextResponse.json(
        { error: "Name and description are required" },
        { status: 400 }
      );
    }

    const agentName = `zyndmixer-${name.replace(/\s+/g, "-").toLowerCase()}`;

    // Generate a stable webhookId upfront so it never changes
    const webhookId = randomUUID();

    const systemPrompt = `You are ${name}.${socialUrl ? ` Social: ${socialUrl}.` : ""
      }\n\nHere is the exact description provided by the user:\n"${description}"\n\nFor every user prompt, use the Zynd Search tool to find relevant agents, then pick the best one and call it via the HTTP Request (x402) tool using its n8nHttpWebhookUrl.\n\nOur agent name is: {{ $workflow.name }} so don't select an agent with this name.`;

    // Step 1: Create the workflow with a fixed webhookId
    const workflowPayload = {
      name: agentName,
      description: description,
      settings: {
        saveExecutionProgress: true,
        saveManualExecutions: true,
        saveDataErrorExecution: "all",
        saveDataSuccessExecution: "all",
        executionTimeout: 3600,
        executionOrder: "v1",
      },
      nodes: [
        {
          parameters: {
            promptType: "define",
            text: "={{ $json.body.prompt }}",
            hasOutputParser: true,
            options: {
              systemMessage: systemPrompt,
            },
          },
          type: "@n8n/n8n-nodes-langchain.agent",
          typeVersion: 3,
          position: [0, 32],
          name: "AI Agent",
        },
        {
          parameters: {
            model: { __rl: true, mode: "list", value: "gpt-4.1-mini" },
            responsesApiEnabled: false,
            options: {},
          },
          type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
          typeVersion: 1.3,
          position: [-48, 320],
          name: "OpenAI Chat Model",
          credentials: {
            openAiApi: { id: "EqoxoHGLtN9VgDEM", name: "OpenAi account" },
          },
        },
        {
          parameters: {},
          type: "CUSTOM.zyndAgentPublisher",
          typeVersion: 1,
          position: [352, 32],
          name: "Zynd Agent Publisher",
          credentials: {
            zyndAiApi: {
              id: "E3AlIG9OQ969gewk",
              name: "ZyndAI account",
            },
          },
        },
        {
          parameters: {
            responseMode: "responseNode",
            serverWalletAddress: "0x212d1fBB46482FCC460A6BdB440dBAC718f51AC2",
            price: "$0",
            options: {},
          },
          type: "CUSTOM.zyndX402Webhook",
          typeVersion: 1,
          position: [-384, 48],
          name: "X402 Webhook",
          webhookId: webhookId,
        },
        {
          parameters: {
            respondWith: "json",
            responseBody:
              "={{ JSON.stringify({ output: $('AI Agent').item.json.output }) }}",
            options: {},
          },
          type: "CUSTOM.respondToWebhook",
          typeVersion: 1.5,
          position: [576, 32],
          name: "Respond to Webhook",
        },
        {
          parameters: {
            agentKeyword:
              '={{ $fromAI("keyword", "give a short description of what kind of agent you want to search", "string") }}',
          },
          type: "CUSTOM.zyndAgentSearchTool",
          typeVersion: 1,
          position: [192, 352],
          name: "Zynd Agent Search",
          credentials: {
            zyndAiApi: {
              id: "E3AlIG9OQ969gewk",
              name: "ZyndAI account",
            },
            web3wallet: {
              id: "cOIJNOQkujh66aTy",
              name: "Web3 Wallet Credentials account",
            },
          },
        },
        {
          parameters: {
            url: '={{ $fromAI("n8nHttpWebhookUrl", "This is the webhook url of the agent we want to call", "string") }}',
            method: "POST",
            sendBody: true,
            jsonBody:
              '={"prompt": "{{ $fromAI("prompt", "Prompt message to ask that agent", "string") }}"}',
            maxPaymentUsd: 0.3,
          },
          type: "CUSTOM.zyndHttpRequestX402Tool",
          typeVersion: 1,
          position: [336, 352],
          name: "HTTP Request (x402)",
          credentials: {
            web3wallet: {
              id: "cOIJNOQkujh66aTy",
              name: "Web3 Wallet Credentials account",
            },
          },
        },
      ],
      connections: {
        "AI Agent": {
          main: [
            [
              {
                node: "Zynd Agent Publisher",
                type: "main",
                index: 0,
              },
            ],
          ],
        },
        "OpenAI Chat Model": {
          ai_languageModel: [
            [
              {
                node: "AI Agent",
                type: "ai_languageModel",
                index: 0,
              },
            ],
          ],
        },
        "Zynd Agent Publisher": {
          main: [
            [
              {
                node: "Respond to Webhook",
                type: "main",
                index: 0,
              },
            ],
          ],
        },
        "X402 Webhook": {
          main: [
            [
              {
                node: "AI Agent",
                type: "main",
                index: 0,
              },
            ],
          ],
        },
        "Zynd Agent Search": {
          ai_tool: [
            [
              {
                node: "AI Agent",
                type: "ai_tool",
                index: 0,
              },
            ],
          ],
        },
        "HTTP Request (x402)": {
          ai_tool: [
            [
              {
                node: "AI Agent",
                type: "ai_tool",
                index: 0,
              },
            ],
          ],
        },
      },
    };

    const createRes = await fetch(`${N8N_BASE}/api/v1/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        "X-API-KEY": X_API_KEY,
        "X-N8N-API-KEY": X_N8N_API_KEY,
      },
      body: JSON.stringify(workflowPayload),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      return NextResponse.json(
        { error: "Failed to create workflow", details: errText },
        { status: createRes.status }
      );
    }

    const createData = await createRes.json();
    const workflowId = createData.id;
    console.log(description, "=====")
    // Step 2: Update workflow description via n8n internal REST API
    if (description) {
      const updatePayload = {
        ...createData,
        description: description,
      };

      console.log(updatePayload, "=====")

      // Remove read-only fields that the API won't accept on update
      delete updatePayload.id;
      delete updatePayload.createdAt;
      delete updatePayload.updatedAt;
      delete updatePayload.shared;
      delete updatePayload.activeVersion;

      await fetch(`${N8N_BASE}/rest/workflows/${workflowId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          cookie: `n8n-auth=${X_N8N_API_KEY}`,
          "X-N8N-API-KEY": X_N8N_API_KEY,
        },
        body: JSON.stringify(updatePayload),
      });
    }

    // Step 3: Activate the workflow
    const activateRes = await fetch(
      `${N8N_BASE}/api/v1/workflows/${workflowId}/activate`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "X-N8N-API-KEY": X_N8N_API_KEY,
        },
      }
    );

    if (!activateRes.ok) {
      const errText = await activateRes.text();
      return NextResponse.json(
        { error: "Failed to activate workflow", details: errText },
        { status: activateRes.status }
      );
    }

    // We already know the webhookId — we set it ourselves.
    // Build the webhook URL directly, no need to GET and parse.
    const webhookUrl = `${N8N_BASE}/webhook/${webhookId}/pay`;

    return NextResponse.json({
      success: true,
      workflowId,
      agentName,
      webhookId,
      webhookUrl,
      createdAt: createData.createdAt,
      active: true,
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
