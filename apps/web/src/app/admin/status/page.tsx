import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { navItem } from "@/lib/account-nav";
import { apiBaseUrl } from "@/lib/env";
import { StatusDashboard } from "./dashboard";

const item = navItem("admin-status");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

export default function StatusPage() {
  // Public WS endpoint only; admin HTTP goes through /api/proxy so the bearer stays server-side.
  const apiUrl = apiBaseUrl() ?? "http://localhost:3456";

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <StatusDashboard apiUrl={apiUrl} />
    </SettingsSection>
  );
}
