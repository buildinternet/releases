import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Header } from "@/components/header";
import { DeviceApproveForm } from "@/components/device-approve-form";
import { AUTH_UI_ENABLED, DEVICE_AUTH_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Approve device",
  description: "Approve or deny a Releases CLI device authorization request.",
  alternates: { canonical: "/device/approve" },
  robots: { index: false, follow: false },
};

export default function DeviceApprovePage() {
  if (!AUTH_UI_ENABLED || !DEVICE_AUTH_ENABLED || !process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Device
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Approve access
          </h1>
          <p className="mt-4 leading-6">
            Only approve a request you started yourself. Approving issues a personal{" "}
            <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">
              relu_
            </code>{" "}
            API key to the CLI.
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          {/* useSearchParams in the form requires a Suspense boundary in the App Router. */}
          <Suspense
            fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}
          >
            <DeviceApproveForm />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
