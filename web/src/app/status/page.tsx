import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { StatusDashboard } from "./dashboard";
import { statusDashboard } from "@/flags";

export const metadata: Metadata = { title: "Status" };

export default function StatusPage() {
  if (!statusDashboard) notFound();

  // apiUrl is only used client-side for the WebSocket connection to /v1/status/ws,
  // which has no auth. Admin HTTP calls go through /api/proxy/... so the bearer
  // never crosses server→client.
  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
            Status
          </h1>
        </div>
        <StatusDashboard apiUrl={apiUrl} />
      </div>
    </div>
  );
}
