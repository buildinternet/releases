import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { WebhooksApiPanel } from "@/components/webhooks-api-panel";
import { navItem } from "@/lib/account-nav";
import { fetchDeveloperSettingsServer } from "@/lib/me-settings-server";

const item = navItem("webhooks");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default async function AccountWebhooksPage() {
  const initial = await fetchDeveloperSettingsServer();

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <WebhooksApiPanel initial={initial} />
    </SettingsSection>
  );
}
