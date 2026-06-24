// web/src/app/account/workspaces/[id]/page.tsx
import type { Metadata } from "next";
import { AccountSection } from "@/components/account-section";
import { WorkspaceDetailPanel } from "@/components/workspace-detail-panel";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Manage workspace members and invitations on releases.sh.",
  robots: { index: false, follow: false },
};

export default async function WorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AccountSection title="Workspace" description="Manage members and invitations.">
      <WorkspaceDetailPanel organizationId={id} />
    </AccountSection>
  );
}
