"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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

type FilterKey = "all" | "running" | "starting" | "crashed" | "failed" | "stopped";

const STARTING_STATUSES: DeploymentStatus[] = [
  "queued",
  "unpacking",
  "writing_config",
  "allocating_port",
  "building",
  "starting",
  "health_checking",
  "registering_route",
];

function matchesFilter(row: DeploymentRow, f: FilterKey): boolean {
  switch (f) {
    case "all":
      return true;
    case "running":
      return row.status === "running" || row.status === "unhealthy";
    case "starting":
      return STARTING_STATUSES.includes(row.status);
    case "crashed":
      return row.status === "crashed";
    case "failed":
      return row.status === "failed";
    case "stopped":
      return row.status === "stopped";
  }
}

interface Counts {
  total: number;
  running: number;
  starting: number;
  crashed: number;
  failed: number;
  stopped: number;
}

function countRows(rows: DeploymentRow[]): Counts {
  const c: Counts = {
    total: rows.length,
    running: 0,
    starting: 0,
    crashed: 0,
    failed: 0,
    stopped: 0,
  };
  for (const r of rows) {
    if (r.status === "running" || r.status === "unhealthy") c.running++;
    else if (STARTING_STATUSES.includes(r.status)) c.starting++;
    else if (r.status === "crashed") c.crashed++;
    else if (r.status === "failed") c.failed++;
    else if (r.status === "stopped") c.stopped++;
  }
  return c;
}

export function DeploymentList() {
  const [rows, setRows] = useState<DeploymentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");

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

  const counts = useMemo(() => (rows ? countRows(rows) : null), [rows]);
  const filtered = useMemo(
    () => (rows ? rows.filter((r) => matchesFilter(r, filter)) : null),
    [rows, filter]
  );

  if (err) {
    return (
      <div className="rounded border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
        Failed to load deployments: {err}
      </div>
    );
  }
  if (!rows || !counts || !filtered) {
    return <div className="text-sm text-white/50">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <StatsBar counts={counts} filter={filter} setFilter={setFilter} />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-10 text-center">
          <p className="text-white/70">No deployments yet.</p>
          <Link
            href="/deploy"
            className="mt-4 inline-block rounded-md bg-zynd-purple px-4 py-2 text-sm font-medium text-white hover:bg-zynd-purple/90"
          >
            Deploy your first agent
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm text-white/50">
          No deployments match this filter.
        </div>
      ) : (
        <DeploymentTable rows={filtered} />
      )}
    </div>
  );
}

interface StatsBarProps {
  counts: Counts;
  filter: FilterKey;
  setFilter: (f: FilterKey) => void;
}

function StatsBar({ counts, filter, setFilter }: StatsBarProps) {
  const cards: Array<{
    key: FilterKey;
    label: string;
    value: number;
    accent: string;
  }> = [
    { key: "all", label: "Total", value: counts.total, accent: "text-white" },
    {
      key: "running",
      label: "Running",
      value: counts.running,
      accent: "text-emerald-300",
    },
    {
      key: "starting",
      label: "Starting",
      value: counts.starting,
      accent: "text-amber-200",
    },
    {
      key: "crashed",
      label: "Crashed",
      value: counts.crashed,
      accent: "text-rose-200",
    },
    {
      key: "failed",
      label: "Failed",
      value: counts.failed,
      accent: "text-rose-300",
    },
    {
      key: "stopped",
      label: "Stopped",
      value: counts.stopped,
      accent: "text-white/60",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => {
        const active = filter === c.key;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => setFilter(c.key)}
            className={`rounded-lg border px-4 py-3 text-left transition ${
              active
                ? "border-zynd-purple bg-zynd-purple/15"
                : "border-white/10 bg-white/[0.02] hover:border-white/25 hover:bg-white/5"
            }`}
            aria-pressed={active}
          >
            <div className="text-xs uppercase tracking-wide text-white/50">
              {c.label}
            </div>
            <div className={`mt-1 text-2xl font-semibold ${c.accent}`}>
              {c.value}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function EntityIdCell({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
  return (
    <button
      type="button"
      title={value}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // clipboard unavailable — ignore
        }
      }}
      className="font-mono text-xs text-white/70 hover:text-white"
    >
      {copied ? "copied" : short}
    </button>
  );
}

function DeploymentTable({ rows }: { rows: DeploymentRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-white/5 text-xs uppercase tracking-wide text-white/50">
          <tr>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Kind</th>
            <th className="px-4 py-3 font-medium">Entity ID</th>
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
                {r.entityId ? (
                  <EntityIdCell value={r.entityId} />
                ) : (
                  <span className="text-xs text-white/30">—</span>
                )}
              </td>
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
