import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { NotificationsPanel } from "@/components/notifications-panel";

export const metadata: Metadata = {
  title: "Notifications",
  description: "Manage email digests and feed subscriptions for your releases.sh account.",
  alternates: { canonical: "/account/notifications" },
  robots: { index: false, follow: false },
};

export default function AccountNotificationsPage() {
  return (
    <AccountSection
      title="Notifications"
      description="Choose how you want to hear about new releases from the orgs and products you follow."
    >
      <NotificationsPanel />
    </AccountSection>
  );
}
