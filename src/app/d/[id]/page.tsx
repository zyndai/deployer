import Link from "next/link";
import { notFound } from "next/navigation";

import { LogStream } from "@/components/LogStream";
import { StatusBadge } from "@/components/StatusBadge";
import { StopButton } from "@/components/StopButton";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { id: string };

export default async function DeploymentPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { id } = await params;
  const dep = await prisma.deployment.findUnique({ where: { id } });
  if (!dep) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-white/40">
            <Link href="/" className="hover:underline">
              ← deployments
            </Link>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {dep.name}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-white/60">
            <span className="font-mono">{dep.slug}</span>
            <span className="text-white/20">·</span>
            <span>{dep.entityType}</span>
            <span className="text-white/20">·</span>
            <StatusBadge status={dep.status} />
          </div>
        </div>
        <StopButton id={dep.id} disabled={dep.status !== "running"} />
      </div>

      <section className="grid grid-cols-2 gap-4 rounded-lg border border-white/10 bg-white/5 p-5 text-sm">
        <Detail label="Public URL">
          {dep.hostUrl ? (
            <a
              href={dep.hostUrl}
              className="font-mono text-xs text-zynd-amber hover:underline"
              target="_blank"
              rel="noreferrer"
            >
              {dep.hostUrl}
            </a>
          ) : (
            <span className="text-white/30">allocated after start</span>
          )}
        </Detail>
        <Detail label="Registry URL">
          <span className="font-mono text-xs">{dep.registryUrl}</span>
        </Detail>
        <Detail label="Entity ID">
          <span className="font-mono text-xs text-white/70">
            {dep.entityId ?? "—"}
          </span>
        </Detail>
        <Detail label="Public key">
          <span className="font-mono text-xs text-white/70">
            {dep.publicKeyB64 ? `${dep.publicKeyB64.slice(0, 44)}…` : "—"}
          </span>
        </Detail>
        <Detail label="Host port">
          <span className="font-mono text-xs">{dep.port ?? "—"}</span>
        </Detail>
        <Detail label="Container">
          <span className="font-mono text-xs">
            {dep.containerId?.slice(0, 12) ?? "—"}
          </span>
        </Detail>
        <Detail label="Created">
          {new Date(dep.createdAt).toLocaleString()}
        </Detail>
        <Detail label="Started">
          {dep.startedAt ? new Date(dep.startedAt).toLocaleString() : "—"}
        </Detail>
        {dep.lastExitCode !== null && dep.lastExitCode !== undefined && (
          <Detail label="Last exit code">
            <span className="text-rose-300">{dep.lastExitCode}</span>
          </Detail>
        )}
        {dep.errorMessage && (
          <Detail label="Error">
            <span className="text-rose-300">{dep.errorMessage}</span>
          </Detail>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-white/80">Live logs</h2>
        <LogStream deploymentId={dep.id} />
      </section>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-white/40">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
