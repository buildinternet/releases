import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { OauthConsentForm } from "@/components/oauth-consent-form";
import { AuthCenter } from "@/components/auth-flow";
import { AUTH_CONFIGURED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Authorize application",
  description: "Grant an application access to your Releases account.",
  alternates: { canonical: "/oauth/consent" },
  robots: { index: false, follow: false },
};

export default function OauthConsentPage() {
  // The consent page is part of the human-auth surface and is meaningless without
  // sign-in, which AUTH_CONFIGURED governs. No consent-specific feature flag (per
  // spec); NEXT_PUBLIC_BETTER_AUTH_URL is a functional prerequisite (the auth
  // client 404s without it), matching the device/page.tsx gate pattern.
  if (!AUTH_CONFIGURED) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <AuthCenter>
        {/* useSearchParams in the form requires a Suspense boundary in the App Router. */}
        <Suspense fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}>
          <OauthConsentForm />
        </Suspense>
      </AuthCenter>
    </div>
  );
}
