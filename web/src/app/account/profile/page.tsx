import type { Metadata } from "next";
import { SettingsSection } from "@/components/account/settings-section";
import { ProfilePanel } from "@/components/profile-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("profile");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountProfilePage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <ProfilePanel />
    </SettingsSection>
  );
}
