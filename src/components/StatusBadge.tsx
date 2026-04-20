import type { DeploymentStatus } from "@/lib/types";

const STYLES: Record<DeploymentStatus, string> = {
  queued: "bg-white/10 text-white/70",
  unpacking: "bg-white/10 text-white/70",
  writing_config: "bg-white/10 text-white/70",
  allocating_port: "bg-white/10 text-white/70",
  building: "bg-amber-500/20 text-amber-200",
  starting: "bg-amber-500/20 text-amber-200",
  health_checking: "bg-amber-500/20 text-amber-200",
  registering_route: "bg-amber-500/20 text-amber-200",
  running: "bg-emerald-500/20 text-emerald-300",
  failed: "bg-rose-500/20 text-rose-300",
  stopped: "bg-white/10 text-white/60",
  crashed: "bg-rose-500/30 text-rose-200",
};

export function StatusBadge({ status }: { status: DeploymentStatus | string }) {
  const key = (status as DeploymentStatus) in STYLES
    ? (status as DeploymentStatus)
    : ("queued" as DeploymentStatus);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[key]}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
