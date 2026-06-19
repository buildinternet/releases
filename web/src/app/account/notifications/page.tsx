import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { NotificationsPanel } from "@/components/notifications-panel";

export const metadata: Metadata = {
  title: "Notifications",
  description:
    "Manage email digests, feed subscriptions, and real-time webhooks for your releases.sh account.",
  alternates: { canonical: "/account/notifications" },
  robots: { index: false, follow: false },
};

export default function AccountNotificationsPage() {
  return (
    <AccountSection
      title="Notifications"
      description="Choose how you want to hear about new releases — email digest, private feed, or signed HTTPS webhooks."
    >
      <NotificationsPanel />
    </AccountSection>
  );
}
