"use client";

import { useState, useEffect, useRef, FormEvent } from "react";

interface AgentInfo {
  workflowId: string;
  agentName: string;
  webhookId: string;
  webhookUrl: string;
  createdAt: string;
  active: boolean;
  userName: string;
  socialUrl: string;
  description: string;
}

interface ChatMessage {
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

const STORAGE_KEY = "zyndmixer-agent-data";
const CHAT_KEY = "zyndmixer-chat-history";

function loadAgent(): AgentInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAgent(agent: AgentInfo) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(agent));
}

function loadChat(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveChat(messages: ChatMessage[]) {
  localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
}

export default function Home() {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [view, setView] = useState<"form" | "dashboard">("form");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [hydrated, setHydrated] = useState(false);

  // Form fields
  const [name, setName] = useState("");
  const [socialUrl, setSocialUrl] = useState("");
  const [description, setDescription] = useState("");

  // Chat
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = loadAgent();
    const savedChat = loadChat();
    if (saved && saved.webhookId && saved.webhookUrl) {
      setAgent(saved);
      setView("dashboard");
    }
    if (savedChat.length > 0) {
      setChatMessages(savedChat);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  async function handleDeploy(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, socialUrl, description }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Deployment failed");
        return;
      }

      const agentInfo: AgentInfo = {
        workflowId: data.workflowId,
        agentName: data.agentName,
        webhookId: data.webhookId,
        webhookUrl: data.webhookUrl,
        createdAt: data.createdAt,
        active: data.active,
        userName: name,
        socialUrl,
        description,
      };

      saveAgent(agentInfo);
      setAgent(agentInfo);
      setView("dashboard");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Network error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleChat(e: FormEvent) {
    e.preventDefault();
    if (!chatInput.trim() || !agent?.webhookUrl) return;

    const userMsg: ChatMessage = {
      role: "user",
      content: chatInput.trim(),
      timestamp: new Date().toISOString(),
    };

    const updated = [...chatMessages, userMsg];
    setChatMessages(updated);
    saveChat(updated);
    setChatInput("");
    setChatLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookUrl: agent.webhookUrl,
          prompt: userMsg.content,
        }),
      });

      const data = await res.json();

      const agentMsg: ChatMessage = {
        role: "agent",
        content:
          data.output ||
          data.data?.output ||
          data.error ||
          JSON.stringify(data),
        timestamp: new Date().toISOString(),
      };

      const withResponse = [...updated, agentMsg];
      setChatMessages(withResponse);
      saveChat(withResponse);
    } catch {
      const errMsg: ChatMessage = {
        role: "agent",
        content: "Failed to reach the agent. Please try again.",
        timestamp: new Date().toISOString(),
      };
      const withErr = [...updated, errMsg];
      setChatMessages(withErr);
      saveChat(withErr);
    } finally {
      setChatLoading(false);
    }
  }

  function handleReset() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CHAT_KEY);
    setAgent(null);
    setChatMessages([]);
    setName("");
    setSocialUrl("");
    setDescription("");
    setView("form");
  }

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-white" />
      </div>
    );
  }

  // ---------- FORM VIEW ----------
  if (view === "form") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-950 p-8">
          <h1 className="mb-1 text-2xl font-bold text-white">
            Deploy Your Agent
          </h1>
          <p className="mb-8 text-sm text-zinc-400">
            Fill in your details to create and deploy a ZyndMixer AI agent.
          </p>

          <form onSubmit={handleDeploy} className="flex flex-col gap-5">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="e.g. Punit"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-white placeholder-zinc-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                LinkedIn or Twitter URL
              </label>
              <input
                type="url"
                value={socialUrl}
                onChange={(e) => setSocialUrl(e.target.value)}
                placeholder="https://twitter.com/yourhandle"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-white placeholder-zinc-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">
                Profile Description *
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                rows={4}
                placeholder="Describe yourself or what your agent should do..."
                className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-white placeholder-zinc-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>

            {error && (
              <div className="rounded-lg border border-red-800 bg-red-950 p-3 text-sm text-red-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-2 rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  Deploying...
                </span>
              ) : (
                "Deploy Agent"
              )}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ---------- DASHBOARD VIEW ----------
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* Sidebar - Agent Info */}
      <aside className="w-full border-b border-zinc-800 bg-zinc-950 p-6 lg:w-80 lg:border-b-0 lg:border-r">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Your Agent</h2>
          <button
            onClick={handleReset}
            className="rounded-md px-3 py-1 text-xs text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            Reset
          </button>
        </div>

        {agent && (
          <div className="flex flex-col gap-4 text-sm">
            <InfoRow label="Agent Name" value={agent.agentName} />
            <InfoRow label="User" value={agent.userName} />
            {agent.socialUrl && (
              <InfoRow label="Social" value={agent.socialUrl} link />
            )}
            <InfoRow label="Workflow ID" value={agent.workflowId} mono />
            <InfoRow label="Webhook ID" value={agent.webhookId} mono />
            <div>
              <span className="block text-xs text-zinc-500">Webhook URL</span>
              <code className="mt-1 block break-all rounded bg-zinc-900 px-2 py-1.5 text-xs text-green-400">
                {agent.webhookUrl}
              </code>
            </div>
            <InfoRow
              label="Status"
              value={agent.active ? "Active" : "Inactive"}
              badge={agent.active ? "green" : "red"}
            />
            <InfoRow
              label="Created"
              value={new Date(agent.createdAt).toLocaleString()}
            />
            <div>
              <span className="block text-xs text-zinc-500">Description</span>
              <p className="mt-1 text-xs leading-relaxed text-zinc-300">
                {agent.description}
              </p>
            </div>
          </div>
        )}
      </aside>

      {/* Chat Area */}
      <main className="flex flex-1 flex-col">
        <div className="border-b border-zinc-800 px-6 py-4">
          <h2 className="text-lg font-bold text-white">
            Chat with {agent?.agentName}
          </h2>
          <p className="text-xs text-zinc-500">
            Send prompts to your deployed agent
          </p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6">
          {chatMessages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-zinc-600">
                No messages yet. Start chatting with your agent.
              </p>
            </div>
          )}

          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {chatMessages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${
                  msg.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "border border-zinc-800 bg-zinc-900 text-zinc-200"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  <p
                    className={`mt-1 text-[10px] ${
                      msg.role === "user" ? "text-blue-200" : "text-zinc-600"
                    }`}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </p>
                </div>
              </div>
            ))}

            {chatLoading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-400">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                  Agent is thinking...
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Input */}
        <form onSubmit={handleChat} className="border-t border-zinc-800 p-4">
          <div className="mx-auto flex max-w-3xl gap-3">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type your message..."
              disabled={chatLoading}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-white placeholder-zinc-500 outline-none transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={chatLoading || !chatInput.trim()}
              className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  link,
  badge,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: boolean;
  badge?: "green" | "red";
}) {
  return (
    <div>
      <span className="block text-xs text-zinc-500">{label}</span>
      {link ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 block break-all text-sm text-blue-400 underline"
        >
          {value}
        </a>
      ) : badge ? (
        <span
          className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
            badge === "green"
              ? "bg-green-950 text-green-400"
              : "bg-red-950 text-red-400"
          }`}
        >
          {value}
        </span>
      ) : (
        <span
          className={`mt-0.5 block break-all text-sm text-zinc-200 ${
            mono ? "font-mono text-xs" : ""
          }`}
        >
          {value}
        </span>
      )}
    </div>
  );
}
