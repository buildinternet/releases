import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { ApiKeysPanel } from "@/components/api-keys-panel";
import { PasskeysPanel } from "@/components/passkeys-panel";
import { EmailPanel } from "@/components/email-panel";
import { SocialConnectionsPanel } from "@/components/social-connections-panel";
import { AUTH_CONFIGURED, USER_API_KEYS_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Account",
  description: "Manage your releases.sh account email, connections, passkeys, and API keys.",
  alternates: { canonical: "/account" },
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  // Dark only when the Better Auth client base URL is unconfigured (else
  // useSession 404s). Passkeys are always available; the API-keys panel still
  // rides its own reveal flag (USER_API_KEYS_ENABLED), mirroring the server-side
  // `user-api-keys-enabled` Flagship gate.
  if (!AUTH_CONFIGURED) {
    notFound();
  }
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto w-full max-w-3xl space-y-16 px-6 py-12">
        <EmailPanel />
        {/* Self-renders nothing when no social providers are configured. */}
        <SocialConnectionsPanel />
        <PasskeysPanel />
        {USER_API_KEYS_ENABLED && <ApiKeysPanel />}
      </div>
    </div>
  );
}
