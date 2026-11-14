import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { listSubmissionsAction, triageSubmissionAction } from "@/app/actions/admin-submissions";
import { navItem } from "@/lib/account-nav";
import { SubmissionsInbox, type SubmissionsActions } from "./submissions-inbox";

const item = navItem("admin-submissions");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

const actions: SubmissionsActions = {
  list: listSubmissionsAction,
  triage: triageSubmissionAction,
};

export default async function AdminSubmissionsPage() {
  const result = await listSubmissionsAction();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <SubmissionsInbox
        initial={result.ok ? result.data : null}
        initialError={result.ok ? null : result.error}
        actions={actions}
      />
    </SettingsSection>
  );
}
