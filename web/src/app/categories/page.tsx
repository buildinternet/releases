import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CategoryListItem } from "@/lib/api";
import { Header } from "@/components/header";
import { MemberFacepile } from "@/components/member-facepile";
import { PageHeader } from "@/components/page-header";
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
        <PageHeader
          breadcrumb={[{ label: "Home", href: "/" }, { label: TITLE }]}
          title={TITLE}
          description={DESCRIPTION}
        />

        <ul className="divide-y divide-stone-200 dark:divide-stone-800">
          {categories.map((c) => (
            <li key={c.slug} className="py-4">
              <Link href={`/categories/${c.slug}`} className="group block min-w-0">
                <div className="text-base font-semibold text-stone-900 dark:text-stone-100 group-hover:text-stone-600 dark:group-hover:text-stone-300">
                  {c.name}
                </div>
                {/* Byline only when a curator set a custom description — the old
                    "Releases from orgs and products bucketed as X" boilerplate
                    added nothing. The page-level <meta> description (set above)
                    keeps a generic fallback so the route is never blank for SEO. */}
                {c.description && (
                  <div className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                    {c.description}
                  </div>
                )}
                {c.previewMembers && c.previewMembers.length > 0 && (
                  <MemberFacepile
                    members={c.previewMembers}
                    totalCount={c.orgCount + c.productCount}
                  />
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
