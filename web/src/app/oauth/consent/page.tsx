import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Header } from "@/components/header";
import { OauthConsentForm } from "@/components/oauth-consent-form";
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
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Authorize
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Grant access
          </h1>
          <p className="mt-4 leading-6">
            An application wants to access your Releases account. Review what it can do, then allow
            or deny. You only see the permissions your account is entitled to grant.
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          {/* useSearchParams in the form requires a Suspense boundary in the App Router. */}
          <Suspense
            fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}
          >
            <OauthConsentForm />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
