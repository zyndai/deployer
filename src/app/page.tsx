"use client";

import Link from "next/link";
import { useState } from "react";

import { DashboardStats } from "@/components/DashboardStats";
import { DeploymentList } from "@/components/DeploymentList";

type PageTab = "deployments" | "health";

export default function HomePage() {
  const [tab, setTab] = useState<PageTab>("deployments");

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Deployments</h1>
          <p className="mt-1 text-sm text-white/60">
            Live status of every agent and service hosted on this deployer.
          </p>
        </div>
        <Link
          href="/deploy"
          className="rounded-md bg-zynd-purple px-4 py-2 text-sm font-medium text-white hover:bg-zynd-purple/90"
        >
          + New deployment
        </Link>
      </div>

      <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
        {(["deployments", "health"] as PageTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition ${
              tab === t
                ? "bg-zynd-purple text-white"
                : "text-white/60 hover:bg-white/5 hover:text-white"
            }`}
          >
            {t === "deployments" ? "Deployments" : "Deployer Health"}
          </button>
        ))}
      </div>

      {tab === "deployments" ? <DeploymentList /> : <DashboardStats />}
    </div>
  );
}
