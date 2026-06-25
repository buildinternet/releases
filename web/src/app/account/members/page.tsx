import type { Metadata } from "next";
import { SettingsSection } from "@/components/account/settings-section";
import { MembersPanel } from "@/components/members-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("members");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountMembersPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <MembersPanel />
    </SettingsSection>
  );
}
