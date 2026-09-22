import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import {
  getMarketingClassifierStateAction,
  setMarketingClassifierThresholdAction,
  setSourceMarketingFilterAction,
} from "@/app/actions/marketing-classifier";
import { navItem } from "@/lib/account-nav";
import { ClassifierForm, type ClassifierActions } from "./classifier-form";

const item = navItem("admin-marketing-classifier");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

const actions: ClassifierActions = {
  getState: getMarketingClassifierStateAction,
  setThreshold: setMarketingClassifierThresholdAction,
  setSourceFilter: setSourceMarketingFilterAction,
};

export default async function AdminMarketingClassifierPage() {
  const current = await getMarketingClassifierStateAction();
  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      {current ? (
        <ClassifierForm initial={current} actions={actions} />
      ) : (
        <p className="text-sm text-stone-500">
          Could not load the marketing classifier settings — is the API reachable and admin auth
          configured?
        </p>
      )}
    </SettingsSection>
  );
}
