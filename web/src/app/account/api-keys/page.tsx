import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountSection } from "@/components/account-section";
import { ApiKeysPanel } from "@/components/api-keys-panel";
import { USER_API_KEYS_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "API keys",
  description: "Create and manage personal API keys for releases.sh.",
  alternates: { canonical: "/account/api-keys" },
  robots: { index: false, follow: false },
};

export default function AccountApiKeysPage() {
  if (!USER_API_KEYS_ENABLED) notFound();

  return (
    <AccountSection
      title="API keys"
      description={
        <>
          Personal{" "}
          <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">relu_</code>{" "}
          keys for the Releases API and MCP server. A key is shown once at creation — store it
          somewhere safe.
        </>
      }
    >
      <ApiKeysPanel />
    </AccountSection>
  );
}
