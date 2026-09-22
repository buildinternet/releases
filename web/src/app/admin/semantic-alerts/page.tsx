import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { navItem } from "@/lib/account-nav";
import { SemanticAlertPreviewPanel } from "./preview-panel";
import { SemanticAlertQualityPanel } from "./quality-panel";

const item = navItem("admin-semantic-alerts");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

export default function AdminSemanticAlertsPage() {
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <div className="space-y-10">
        <SemanticAlertQualityPanel />
        <SemanticAlertPreviewPanel />
      </div>
    </SettingsSection>
  );
}
