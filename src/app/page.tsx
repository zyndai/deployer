import Link from "next/link";

import { DeploymentList } from "@/components/DeploymentList";

export default function HomePage() {
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
      <DeploymentList />
    </div>
  );
}
