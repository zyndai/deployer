-- AlterTable: add runtime column with default "python" so existing rows stay valid.
ALTER TABLE "Deployment" ADD COLUMN "runtime" TEXT NOT NULL DEFAULT 'python';
