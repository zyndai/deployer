"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Capacity {
  maxActive: number;
  active: number;
  free: number;
  containerMemoryMb: number;
  containerCpuMillis: number;
  totalReservedMb: number;
  totalUsedMb: number;
  totalFreeReservedMb: number;
}

interface ContainerSample {
  id: string;
  name: string;
  slug: string;
  entityType: "agent" | "service";
  entityId: string | null;
  status: string;
  memUsedMb: number | null;
  memLimitMb: number | null;
  cpuPct: number | null;
  sampledAt: string | null;
  ageMs: number | null;
}

interface StatsPayload {
  capacity: Capacity;
  containers: ContainerSample[];
  metricsIntervalSec: number;
  serverTime: string;
}

const POLL_MS = 3000;

export function DashboardStats() {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as StatsPayload;
        if (!cancelled) {
          setData(json);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  if (err && !data) {
    return (
      <div className="rounded border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
        Failed to load stats: {err}
      </div>
    );
  }
  if (!data) {
    return <div className="text-sm text-white/50">Loading stats…</div>;
  }

  const { capacity, containers, metricsIntervalSec } = data;
  const slotsPct = capacity.maxActive > 0 ? capacity.active / capacity.maxActive : 0;
  const memReservedPct =
    capacity.totalReservedMb > 0
      ? capacity.totalUsedMb / capacity.totalReservedMb
      : 0;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Deployer health</h2>
        <span className="text-xs text-white/40">
          samples ≤ {metricsIntervalSec}s · refresh {POLL_MS / 1000}s
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Slots used"
          primary={`${capacity.active} / ${capacity.maxActive}`}
          secondary={`${capacity.free} free · room for ${capacity.free} more`}
          progress={slotsPct}
          accent={slotsPct > 0.8 ? "rose" : "purple"}
        />
        <MetricCard
          label="Memory in use"
          primary={`${formatMb(capacity.totalUsedMb)}`}
          secondary={`of ${formatMb(capacity.totalReservedMb)} reserved`}
          progress={memReservedPct}
          accent={memReservedPct > 0.85 ? "rose" : "emerald"}
        />
        <MetricCard
          label="Headroom (reserved)"
          primary={formatMb(capacity.totalFreeReservedMb)}
          secondary={`${formatMb(capacity.containerMemoryMb)} per container`}
        />
        <MetricCard
          label="CPU per container"
          primary={`${(capacity.containerCpuMillis / 1000).toFixed(2)} cores`}
          secondary={`${capacity.containerCpuMillis} milliCPU`}
        />
      </div>

      <ContainerTable containers={containers} />
    </section>
  );
}

interface MetricCardProps {
  label: string;
  primary: string;
  secondary?: string;
  progress?: number;
  accent?: "emerald" | "purple" | "rose";
}

function MetricCard({
  label,
  primary,
  secondary,
  progress,
  accent = "purple",
}: MetricCardProps) {
  const barClass =
    accent === "emerald"
      ? "bg-emerald-400"
      : accent === "rose"
        ? "bg-rose-400"
        : "bg-zynd-purple";
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-white/50">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-white">{primary}</div>
      {secondary && (
        <div className="mt-0.5 text-xs text-white/50">{secondary}</div>
      )}
      {progress !== undefined && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full ${barClass}`}
            style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ContainerTable({ containers }: { containers: ContainerSample[] }) {
  if (containers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-white/15 p-6 text-center text-sm text-white/50">
        No running containers right now.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full text-left text-sm">
        <thead className="bg-white/5 text-xs uppercase tracking-wide text-white/50">
          <tr>
            <th className="px-4 py-3 font-medium">Deployment</th>
            <th className="px-4 py-3 font-medium">Memory</th>
            <th className="px-4 py-3 font-medium">CPU</th>
            <th className="px-4 py-3 font-medium">Sample age</th>
          </tr>
        </thead>
        <tbody>
          {containers.map((c) => (
            <ContainerRow key={c.id} c={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ContainerRow({ c }: { c: ContainerSample }) {
  const memPct =
    c.memUsedMb !== null && c.memLimitMb && c.memLimitMb > 0
      ? c.memUsedMb / c.memLimitMb
      : 0;
  const memBar =
    memPct > 0.85 ? "bg-rose-400" : memPct > 0.7 ? "bg-amber-400" : "bg-emerald-400";

  return (
    <tr className="border-t border-white/5 hover:bg-white/5">
      <td className="px-4 py-3">
        <Link
          href={`/d/${c.id}`}
          className="font-medium text-white hover:underline"
        >
          {c.name}
        </Link>
        <div className="text-xs text-white/40">
          {c.entityType} · {c.slug}
          {c.status === "unhealthy" && (
            <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
              unhealthy
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3" style={{ minWidth: 220 }}>
        {c.memUsedMb !== null && c.memLimitMb ? (
          <>
            <div className="font-mono text-xs text-white/80">
              {formatMb(c.memUsedMb)} / {formatMb(c.memLimitMb)}
              <span className="ml-2 text-white/40">
                ({(memPct * 100).toFixed(1)}%)
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full ${memBar}`}
                style={{ width: `${Math.min(100, memPct * 100)}%` }}
              />
            </div>
          </>
        ) : (
          <span className="text-xs text-white/40">no sample yet</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-white/80">
        {c.cpuPct !== null ? `${(c.cpuPct * 100).toFixed(1)}%` : "—"}
      </td>
      <td className="px-4 py-3 text-xs text-white/50">
        {c.ageMs !== null ? formatAge(c.ageMs) : "—"}
      </td>
    </tr>
  );
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}
