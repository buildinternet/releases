import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SettingsSection } from "@/components/account/settings-section";
import { BillingPanel } from "@/components/billing-panel";
import { navItem, SHOW_WIP_PANELS } from "@/lib/account-nav";

const item = navItem("billing");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountBillingPage() {
  if (!SHOW_WIP_PANELS) notFound();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <BillingPanel />
    </SettingsSection>
  );
}
