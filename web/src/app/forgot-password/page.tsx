import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Header } from "@/components/header";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Reset your releases.sh account password.",
  alternates: { canonical: "/forgot-password" },
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  if (!AUTH_UI_ENABLED) notFound();

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Account
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Reset your password
          </h1>
          <p className="mt-4 leading-6">
            Enter your email and we&apos;ll send you a link to set a new password. Remembered it?{" "}
            <Link
              href="/login"
              className="font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
            >
              Sign in
            </Link>
            .
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          <ForgotPasswordForm />
        </section>
      </div>
    </div>
  );
}
