import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/header";
import { ResetPasswordForm } from "@/components/reset-password-form";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Set a new password",
  description: "Set a new password for your releases.sh account.",
  alternates: { canonical: "/reset-password" },
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  if (!AUTH_UI_ENABLED) notFound();
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : undefined;
  const hasError = Boolean(params.error) || !token;

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Account
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Set a new password
          </h1>
          <p className="mt-4 leading-6">Choose a new password for your releases.sh account.</p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          {hasError ? (
            <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
              This password reset link is invalid or has expired.{" "}
              <Link
                href="/forgot-password"
                className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
              >
                Request a new one
              </Link>
              .
            </p>
          ) : (
            <ResetPasswordForm token={token!} />
          )}
        </section>
      </div>
    </div>
  );
}
