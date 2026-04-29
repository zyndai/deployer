-- AlterTable: add nullable `image` so existing rows fall back to the
-- per-runtime default resolved by the worker.
ALTER TABLE "Deployment" ADD COLUMN "image" TEXT;
