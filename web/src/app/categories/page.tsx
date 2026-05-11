import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CategoryListItem } from "@/lib/api";
import { Header } from "@/components/header";
import { SetupMessage } from "@/components/setup-message";

const TITLE = "Categories";
const DESCRIPTION =
  "Browse releases by category on releases.sh — every changelog is bucketed into one of a fixed set of topics so you can follow a slice of the industry at a glance.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/categories" },
  openGraph: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
    url: "/categories",
  },
  twitter: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
  },
};

export default async function CategoriesListPage() {
  let categories: CategoryListItem[];
  try {
    categories = await api.categories();
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <Header />
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="max-w-3xl mx-auto px-6 pt-8 pb-12">
        <div className="text-[13px] text-stone-400 dark:text-stone-500 mb-4">
          <Link href="/" className="hover:text-stone-600 dark:hover:text-stone-300">
            Home
          </Link>
          <span className="mx-1.5">/</span>
          <span className="text-stone-600 dark:text-stone-300 font-medium">Categories</span>
        </div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100 mb-2">
          {TITLE}
        </h1>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-8">{DESCRIPTION}</p>

        <ul className="divide-y divide-stone-200 dark:divide-stone-800">
          {categories.map((c) => (
            <li key={c.slug} className="py-4">
              <Link
                href={`/categories/${c.slug}`}
                className="group flex items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="text-base font-semibold text-stone-900 dark:text-stone-100 group-hover:text-stone-600 dark:group-hover:text-stone-300">
                    {c.name}
                  </div>
                  <div className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                    {c.description ?? (
                      <>
                        Releases from orgs and products bucketed as{" "}
                        <span className="font-medium">{c.name}</span>.
                      </>
                    )}
                  </div>
                </div>
                <CountBadges orgCount={c.orgCount} productCount={c.productCount} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CountBadges({ orgCount, productCount }: { orgCount: number; productCount: number }) {
  return (
    <div className="shrink-0 flex flex-col items-end gap-0.5 text-[12px] tabular-nums text-stone-400 dark:text-stone-500">
      <span>
        {orgCount} {orgCount === 1 ? "org" : "orgs"}
      </span>
      {productCount > 0 && (
        <span>
          {productCount} {productCount === 1 ? "product" : "products"}
        </span>
      )}
    </div>
  );
}
