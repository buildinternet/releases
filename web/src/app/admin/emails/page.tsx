import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl, serverApiKey } from "@/lib/env";
import { getServerSessionUser, isAdminViewer } from "@/lib/server-session";
import { EmailTestPanel } from "./email-test-panel";

export const metadata: Metadata = { title: "Test emails" };

type SamplesResponse = {
  samples: Array<{
    id: string;
    label: string;
    description: string;
    channel: "auth" | "operator";
  }>;
};

async function loadSamples(): Promise<SamplesResponse["samples"]> {
  const base = apiBaseUrl();
  const key = serverApiKey();
  if (!base || !key) return [];
  try {
    const res = await fetch(`${base}/v1/admin/emails/samples`, {
      headers: webApiHeaders({ Authorization: `Bearer ${key}` }),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body = (await res.json()) as SamplesResponse;
    return body.samples ?? [];
  } catch {
    return [];
  }
}

export default async function AdminEmailsPage() {
  if (!(await isAdminViewer())) notFound();

  const [samples, user] = await Promise.all([loadSamples(), getServerSessionUser()]);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto max-w-3xl px-6 pb-12 pt-8">
        <p className="mb-2 text-[13px] text-stone-500 dark:text-stone-400">
          <Link href="/admin" className="hover:underline">
            Admin
          </Link>
        </p>
        <h1 className="mb-2 text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">
          Test emails
        </h1>
        <p className="mb-8 text-sm text-stone-600 dark:text-stone-400">
          Send a fabricated sample of every outbound email template to your inbox. Useful for
          checking footers, links, and deliverability after template changes.
        </p>
        {samples.length === 0 ? (
          <p className="text-sm text-stone-500">
            Could not load the sample catalog — is the API reachable and admin auth configured?
          </p>
        ) : (
          <EmailTestPanel samples={samples} defaultEmail={user?.email ?? ""} />
        )}
      </div>
    </div>
  );
}
