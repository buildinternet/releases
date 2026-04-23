import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { MemoryDashboard } from "./dashboard";
import { statusDashboard } from "@/flags";

export const metadata: Metadata = { title: "Memory stores" };

export default function MemoryPage() {
  if (!statusDashboard) notFound();

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
            Memory stores
          </h1>
        </div>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-6">
          Managed-agents memory stores attached to discovery and worker sessions. Read-only view —
          edits happen via the API or Anthropic console. See{" "}
          <a
            className="underline"
            href="https://github.com/buildinternet/releases/issues/537"
            target="_blank"
            rel="noopener noreferrer"
          >
            issue #537
          </a>{" "}
          for the design.
        </p>
        <MemoryDashboard />
      </div>
    </div>
  );
}
