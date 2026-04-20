import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "Zynd Deployer",
  description: "Host your Zynd agents and services on a stable HTTPS URL.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-white/10">
          <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-6 w-6 rounded bg-zynd-purple" />
              <span className="text-lg font-semibold tracking-tight">
                Zynd Deployer
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-white/70">
              <Link href="/" className="hover:text-white">
                Deployments
              </Link>
              <Link
                href="/deploy"
                className="rounded-md bg-zynd-purple px-3 py-1.5 text-white font-medium hover:bg-zynd-purple/90"
              >
                New deployment
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
