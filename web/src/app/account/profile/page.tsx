import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { ProfilePanel } from "@/components/profile-panel";

export const metadata: Metadata = {
  title: "Profile",
  description: "View your releases.sh account profile.",
  alternates: { canonical: "/account/profile" },
  robots: { index: false, follow: false },
};

export default function AccountProfilePage() {
  return (
    <AccountSection
      title="Profile"
      description="Your account identity on releases.sh. Name and avatar come from your sign-in provider."
    >
      <ProfilePanel />
    </AccountSection>
  );
}
