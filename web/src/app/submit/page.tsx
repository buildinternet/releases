import type { Metadata } from "next";
import { Header } from "@/components/header";
import { SubmitSourceForm } from "./submit-source-form";

export const metadata: Metadata = {
  title: "Submit a Source",
  description: "Recommend a release notes URL for the releases.sh changelog registry.",
  alternates: { canonical: "/submit" },
};

export default function SubmitPage() {
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Open Catalog
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Submit a release source
          </h1>
          <p className="mt-4 leading-6">
            Recommend a changelog, release notes page, feed, or GitHub releases URL for the
            registry.
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          <SubmitSourceForm />
        </section>
      </div>
    </div>
  );
}
