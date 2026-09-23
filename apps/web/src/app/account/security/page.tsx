import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { SecurityPanel } from "@/components/security-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("security");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountSecurityPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <SecurityPanel />
    </SettingsSection>
  );
}
