import { PrismaClient } from "@prisma/client";

// Singleton Prisma client. Next.js dev mode hot-reloads modules, so we
// stash the instance on globalThis to avoid opening a new pool on every
// HMR tick.

declare global {
  // eslint-disable-next-line no-var
  var __zyndPrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__zyndPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__zyndPrisma = prisma;
}
