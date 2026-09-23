import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettingsSection } from "@releases/design-system";
import { DangerPanel } from "@/components/danger-panel";
import { navItem, SHOW_WIP_PANELS } from "@/lib/account-nav";

const item = navItem("danger");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountDangerPage() {
  if (!SHOW_WIP_PANELS) notFound();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <DangerPanel />
    </SettingsSection>
  );
}
