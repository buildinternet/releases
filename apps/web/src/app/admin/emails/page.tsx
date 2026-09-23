import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { webApiHeaders } from "@/lib/api";
import { navItem } from "@/lib/account-nav";
import { apiBaseUrl, serverApiKey } from "@/lib/env";
import { getServerSessionUser } from "@/lib/server-session";
import { EmailTestPanel } from "./email-test-panel";

const item = navItem("admin-emails");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

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
  const [samples, user] = await Promise.all([loadSamples(), getServerSessionUser()]);

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      {samples.length === 0 ? (
        <p className="text-sm text-stone-500">
          Could not load the sample catalog — is the API reachable and admin auth configured?
        </p>
      ) : (
        <EmailTestPanel samples={samples} defaultEmail={user?.email ?? ""} />
      )}
    </SettingsSection>
  );
}
