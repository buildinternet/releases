import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { WorkspacesPanel } from "@/components/workspaces-panel";

export const metadata: Metadata = {
  title: "Workspaces",
  description: "Manage your workspaces on releases.sh.",
  alternates: { canonical: "/account/workspaces" },
  robots: { index: false, follow: false },
};

export default function AccountWorkspacesPage() {
  return (
    <AccountSection
      title="Workspaces"
      description="A workspace groups your account for upcoming team features. You always have a personal workspace, and you can create more."
    >
      <WorkspacesPanel />
    </AccountSection>
  );
}
