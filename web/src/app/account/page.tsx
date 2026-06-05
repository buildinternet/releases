import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { ApiKeysPanel } from "@/components/api-keys-panel";
import { AUTH_UI_ENABLED, USER_API_KEYS_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Account",
  description: "Manage your releases.sh account and API keys.",
  alternates: { canonical: "/account" },
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  // Dark unless the auth UI master switch AND the API-keys reveal flag are on,
  // and the Better Auth client base URL is configured (else useSession 404s).
  if (!AUTH_UI_ENABLED || !USER_API_KEYS_ENABLED || !process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    notFound();
  }
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto w-full max-w-3xl px-6 py-12">
        <ApiKeysPanel />
      </div>
    </div>
  );
}
