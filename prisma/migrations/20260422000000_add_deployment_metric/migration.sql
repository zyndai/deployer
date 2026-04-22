-- CreateTable
CREATE TABLE "DeploymentMetric" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memUsedMb" INTEGER NOT NULL,
    "memLimitMb" INTEGER NOT NULL,
    "cpuPct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "DeploymentMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeploymentMetric_deploymentId_sampledAt_idx" ON "DeploymentMetric"("deploymentId", "sampledAt");

-- CreateIndex
CREATE INDEX "DeploymentMetric_sampledAt_idx" ON "DeploymentMetric"("sampledAt");
