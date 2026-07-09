import type { Metadata } from "next";
import Link from "next/link";
import { Header } from "@/components/header";
import { ListingFastLane } from "./listing-fast-lane";
import { SubmitSourceForm } from "./submit-source-form";

export const metadata: Metadata = {
  title: "Submit Your Product",
  description:
    "Add your product to the releases.sh registry with a releases.json manifest or a release notes URL.",
  alternates: { canonical: "/submit" },
  openGraph: { type: "website", url: "/submit" },
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
            Submit Your Product
          </h1>
          <p className="mt-4 leading-6">
            Publish a{" "}
            <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[0.85em] text-stone-700 dark:bg-stone-800 dark:text-stone-200">
              releases.json
            </code>{" "}
            on your domain and activate here — or suggest a changelog URL for a curator.{" "}
            <Link
              href="/docs/listing"
              className="font-medium text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
            >
              How to get listed
            </Link>
          </p>
        </aside>

        <section className="space-y-10">
          <div className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
            <ListingFastLane />
          </div>

          <div className="border-t border-stone-200 pt-8 dark:border-stone-800">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
              Not your product, or no manifest?
            </p>
            <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
              Suggest a changelog, feed, or GitHub releases URL and a curator will take a look.
            </p>
            <div className="mt-5 border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
              <SubmitSourceForm />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
