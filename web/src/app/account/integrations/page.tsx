import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsSection } from "@releases/design-system";
import { IntegrationsPanel } from "@/components/integrations-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("integrations");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountIntegrationsPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <Suspense fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}>
        <IntegrationsPanel />
      </Suspense>
    </SettingsSection>
  );
}
