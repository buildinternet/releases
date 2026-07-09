import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { listMyTokensAction } from "@/app/actions/api-tokens";
import { navItem } from "@/lib/account-nav";
import { TokensAdmin } from "./tokens-admin";

const item = navItem("admin-api-tokens");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  robots: { index: false, follow: false },
};

export default async function ApiTokensPage() {
  const result = await listMyTokensAction();
  const initialTokens = result.ok ? result.tokens : [];
  const initialError = result.ok ? null : result.error;

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <TokensAdmin initialTokens={initialTokens} initialError={initialError} />
    </SettingsSection>
  );
}
