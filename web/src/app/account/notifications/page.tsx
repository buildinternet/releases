import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { NotificationsPanel } from "@/components/notifications-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("notifications");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountNotificationsPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <NotificationsPanel />
    </SettingsSection>
  );
}
