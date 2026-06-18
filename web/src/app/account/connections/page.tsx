import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountSection } from "@/components/account-section";
import { SocialConnectionsPanel } from "@/components/social-connections-panel";
import { SOCIAL_PROVIDERS } from "@/lib/social-providers";

export const metadata: Metadata = {
  title: "Connections",
  description: "Manage social sign-in connections for your releases.sh account.",
  alternates: { canonical: "/account/connections" },
  robots: { index: false, follow: false },
};

export default function AccountConnectionsPage() {
  if (SOCIAL_PROVIDERS.length === 0) notFound();

  return (
    <AccountSection
      title="Connections"
      description="Link a social account to sign in with one click. You can connect more than one — but you can't remove your last remaining way to sign in."
    >
      <SocialConnectionsPanel />
    </AccountSection>
  );
}
