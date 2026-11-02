import type { Metadata } from "next";
import { SettingsSection } from "@releases/design-system";
import { SecurityPanel } from "@/components/security-panel";
import { navItem } from "@/lib/account-nav";

const item = navItem("security");

export const metadata: Metadata = {
  title: item.label,
  description: item.description,
  alternates: { canonical: item.href },
  robots: { index: false, follow: false },
};

export default async function AccountSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  // `linkSocial` and the change-email confirmation both return here with
  // `?error=`. Only a single string is read; a repeated param is ignored so
  // the banner can't be fed an array.
  const callbackError = typeof params.error === "string" ? params.error : undefined;

  return (
    <SettingsSection group={item.group} title={item.label} description={item.description}>
      <SecurityPanel callbackError={callbackError} />
    </SettingsSection>
  );
}
