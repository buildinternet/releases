import type { Metadata } from "next";
import { SettingsSection } from "@/components/account/settings-section";
import { WorkspaceDetailPanel } from "@/components/workspace-detail-panel";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Manage workspace members and invitations on releases.sh.",
  robots: { index: false, follow: false },
};

export default async function WorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <SettingsSection
      group="Workspace"
      title="Workspace"
      description="Manage members and invitations."
    >
      <WorkspaceDetailPanel workspaceId={id} />
    </SettingsSection>
  );
}
