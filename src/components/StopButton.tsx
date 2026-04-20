"use client";

export function StopButton({ id, disabled }: { id: string; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={async () => {
        if (!confirm("Stop this deployment?")) return;
        const res = await fetch(`/api/deployments/${id}`, { method: "DELETE" });
        if (res.ok) window.location.reload();
      }}
      className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Stop
    </button>
  );
}
