import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { NotificationsPanel } from "@/components/notifications-panel";
import { navItem } from "@/lib/account-nav";
import { fetchNotificationSettingsServer } from "@/lib/me-settings-server";

const item = navItem("notifications");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default async function AccountNotificationsPage() {
  // Cookie-forwarded one-shot bootstrap; null when anonymous / API down — panel
  // falls back to a client fetch in that case.
  const initial = await fetchNotificationSettingsServer();

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <NotificationsPanel initial={initial} />
    </SettingsSection>
  );
}
