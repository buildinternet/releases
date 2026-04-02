import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Header } from "@/components/header";
import { StatusDashboard } from "./dashboard";

export const metadata: Metadata = { title: "Status" };

export default async function StatusPage() {
  if (process.env.RELEASED_DEV_MODE !== "true") {
    redirect("/");
  }

  const apiUrl = process.env.RELEASED_API_URL ?? "http://localhost:3456";

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto px-6 pt-8 pb-12">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">Status</h1>
        </div>
        <StatusDashboard apiUrl={apiUrl} />
      </div>
    </div>
  );
}
