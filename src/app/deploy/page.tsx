"use client";

import { useState } from "react";

import { DeployCard } from "@/components/DeployCard";
import type { Runtime } from "@/lib/types";

export default function DeployPage() {
  const [tab, setTab] = useState<"agent" | "service">("agent");
  const [runtime, setRuntime] = useState<Runtime>("python");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New deployment</h1>
        <p className="mt-1 text-sm text-white/60">
          Your developer key stays on your laptop. Only the agent / service
          identity is uploaded.
        </p>
      </div>

      {/* Runtime toggle */}
      <div className="flex rounded-lg border border-white/10 bg-white/5 p-1 text-sm">
        {(["python", "node"] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRuntime(r)}
            className={`flex-1 rounded-md px-3 py-1.5 transition ${
              runtime === r
                ? "bg-zynd-purple text-white"
                : "text-white/60 hover:text-white"
            }`}
          >
            {r === "python" ? "Python" : "Node.js"}
          </button>
        ))}
      </div>

      {/* Entity-type toggle */}
      <div className="flex rounded-lg border border-white/10 bg-white/5 p-1 text-sm">
        {(["agent", "service"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded-md px-3 py-1.5 capitalize transition ${
              tab === k
                ? "bg-zynd-purple text-white"
                : "text-white/60 hover:text-white"
            }`}
          >
            {k}
          </button>
        ))}
      </div>

      <DeployCard entityType={tab} runtime={runtime} />

      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-xs text-white/50">
        <p className="font-semibold text-white/70">Before you upload</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Run{" "}
            <code className="text-white/80">
              zynd {tab} run
            </code>{" "}
            locally at least once — the first POST to the registry needs your
            developer signature.
          </li>
          <li>
            Make sure your <code className="text-white/80">.env</code> does
            <em> not</em> contain <code>ZYND_DEVELOPER_*</code> keys. The
            uploader will reject those.
          </li>
          {runtime === "python" ? (
            <li>
              Include <code className="text-white/80">requirements.txt</code>{" "}
              if your agent needs extra packages beyond the base image.
            </li>
          ) : (
            <li>
              Include <code className="text-white/80">package.json</code> (and
              optionally <code className="text-white/80">package-lock.json</code>{" "}
              for reproducible installs). Do{" "}
              <em>not</em> include <code className="text-white/80">node_modules/</code>.
            </li>
          )}
          <li>
            You&apos;ll get a stable URL at{" "}
            <code className="text-white/80">
              &lt;slug&gt;.deployer.zynd.ai
            </code>
            . The container auto-updates the registry record on every restart.
          </li>
        </ul>
      </div>
    </div>
  );
}
