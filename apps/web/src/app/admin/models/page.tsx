import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { getAiLaneModelsAction } from "@/app/actions/ai-models";
import { navItem } from "@/lib/account-nav";
import { ModelsForm } from "./models-form";

const item = navItem("admin-models");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

export default async function AdminModelsPage() {
  const current = await getAiLaneModelsAction();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      {current ? (
        <ModelsForm initial={current} />
      ) : (
        <p className="text-sm text-stone-500">
          Could not load AI lane models — is the API reachable and admin auth configured?
        </p>
      )}
    </SettingsSection>
  );
}
