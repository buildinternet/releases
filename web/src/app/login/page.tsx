import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { AuthForm } from "@/components/auth-form";
import { safeRedirect } from "@/lib/auth-redirect";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your releases.sh account.",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string | string[] }>;
}) {
  if (!AUTH_UI_ENABLED) notFound();
  const { redirect } = await searchParams;
  const redirectTo = safeRedirect(redirect);

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Account
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Sign in
          </h1>
          <p className="mt-4 leading-6">
            Sign in to your releases.sh account. Accounts are separate from the{" "}
            <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">
              relk_
            </code>{" "}
            API tokens used by the CLI and MCP.
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          <AuthForm mode="login" redirectTo={redirectTo} />
        </section>
      </div>
    </div>
  );
}
