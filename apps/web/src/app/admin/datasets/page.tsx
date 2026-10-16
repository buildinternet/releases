import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { getAdminDatasetsAction, setSourceDatasetAction } from "@/app/actions/datasets";
import { navItem } from "@/lib/account-nav";
import { DatasetsForm } from "./datasets-form";

const item = navItem("admin-datasets");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

export default async function AdminDatasetsPage() {
  const initial = await getAdminDatasetsAction();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <DatasetsForm
        initial={initial.ok ? initial.data : null}
        initialError={initial.ok ? undefined : initial.error}
        actions={{ getSources: getAdminDatasetsAction, saveSource: setSourceDatasetAction }}
      />
    </SettingsSection>
  );
}
