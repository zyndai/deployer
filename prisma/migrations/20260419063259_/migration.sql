-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "registryUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "blobPath" TEXT NOT NULL,
    "keyPath" TEXT NOT NULL,
    "port" INTEGER,
    "containerId" TEXT,
    "hostUrl" TEXT,
    "publicKeyB64" TEXT,
    "lastExitCode" INTEGER,
    "lastCrashAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentLog" (
    "id" BIGSERIAL NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortAllocation" (
    "port" INTEGER NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortAllocation_pkey" PRIMARY KEY ("port")
);

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_slug_key" ON "Deployment"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_port_key" ON "Deployment"("port");

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE INDEX "Deployment_createdAt_idx" ON "Deployment"("createdAt");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_lineNo_idx" ON "DeploymentLog"("deploymentId", "lineNo");

-- CreateIndex
CREATE INDEX "DeploymentLog_deploymentId_ts_idx" ON "DeploymentLog"("deploymentId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "PortAllocation_deploymentId_key" ON "PortAllocation"("deploymentId");

-- AddForeignKey
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
