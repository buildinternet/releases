import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsSection } from "@releases/design-system";
import { WorkspaceWebhooksPanel } from "@/components/workspace-webhooks-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("workspace-webhooks");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default function AccountWorkspaceWebhooksPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <Suspense fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}>
        <WorkspaceWebhooksPanel />
      </Suspense>
    </SettingsSection>
  );
}
