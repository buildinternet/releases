import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettingsSection } from "@/components/account/settings-section";
import { MembersPanel } from "@/components/members-panel";
import { navItem, SHOW_WIP_PANELS } from "@/lib/account-nav";

const item = navItem("members");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountMembersPage() {
  if (!SHOW_WIP_PANELS) notFound();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <MembersPanel />
    </SettingsSection>
  );
}
