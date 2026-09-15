import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { WebhooksApiPanel } from "@/components/webhooks-api-panel";
import { navItem } from "@/lib/account-nav";
import { fetchDeveloperSettingsServer } from "@/lib/me-settings-server";
import { parseWebhookCreatePrefill } from "@/lib/webhook-create";

const item = navItem("webhooks");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default async function AccountWebhooksPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[]; org?: string | string[] }>;
}) {
  const [initial, params] = await Promise.all([fetchDeveloperSettingsServer(), searchParams]);
  const createPrefill = parseWebhookCreatePrefill(params);

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <WebhooksApiPanel initial={initial} createPrefill={createPrefill} />
    </SettingsSection>
  );
}
