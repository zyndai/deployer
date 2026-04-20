"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { StatusBadge } from "./StatusBadge";
import type { DeploymentStatus } from "@/lib/types";

interface DeploymentRow {
  id: string;
  name: string;
  slug: string;
  entityType: "agent" | "service";
  entityId: string | null;
  status: DeploymentStatus;
  hostUrl: string | null;
  port: number | null;
  lastExitCode: number | null;
  lastCrashAt: string | null;
  createdAt: string;
}

export function DeploymentList() {
  const [rows, setRows] = useState<DeploymentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/deployments", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { deployments: DeploymentRow[] };
        if (!cancelled) setRows(data.deployments);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    };
    load();
    const iv = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  if (err) {
    return (
      <div className="rounded border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
        Failed to load deployments: {err}
      </div>
    );
  }
  if (!rows) {
    return <div className="text-sm text-white/50">Loading…</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-white/15 p-10 text-center">
        <p className="text-white/70">No deployments yet.</p>
        <Link
          href="/deploy"
          className="mt-4 inline-block rounded-md bg-zynd-purple px-4 py-2 text-sm font-medium text-white hover:bg-zynd-purple/90"
        >
          Deploy your first agent
        </Link>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-white/5 text-xs uppercase tracking-wide text-white/50">
          <tr>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Kind</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">URL</th>
            <th className="px-4 py-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-white/5 hover:bg-white/5"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/d/${r.id}`}
                  className="font-medium text-white hover:underline"
                >
                  {r.name}
                </Link>
                <div className="text-xs text-white/40">{r.slug}</div>
              </td>
              <td className="px-4 py-3 text-white/70">{r.entityType}</td>
              <td className="px-4 py-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="px-4 py-3">
                {r.hostUrl ? (
                  <a
                    href={r.hostUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-zynd-amber hover:underline"
                  >
                    {r.hostUrl}
                  </a>
                ) : (
                  <span className="text-xs text-white/30">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-white/50">
                {new Date(r.createdAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
