import type { Metadata } from "next";
import { SettingsSection } from "@/components/account/settings-section";
import { GeneralPanel } from "@/components/general-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("general");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountGeneralPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <GeneralPanel />
    </SettingsSection>
  );
}
