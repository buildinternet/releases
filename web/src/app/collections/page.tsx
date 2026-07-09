import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CollectionListItem } from "@/lib/api";
import { MemberFacepile } from "@/components/member-facepile";
import { PageHeader } from "@/components/page-header";
import { SetupMessage } from "@/components/setup-message";

const TITLE = "Collections";
const DESCRIPTION =
  "Curated playlists of organizations on releases.sh — group changelogs by theme to follow a market or topic in one place.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/collections" },
  openGraph: {
    type: "website",
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
    url: "/collections",
  },
  twitter: {
    title: `${TITLE} — releases.sh`,
    description: DESCRIPTION,
  },
};

export default async function CollectionsListPage() {
  let collections: CollectionListItem[];
  try {
    collections = await api.collections();
  } catch (err) {
    if (err instanceof ApiSetupError) {
      return (
        <div className="min-h-screen">
          <SetupMessage message={err.message} steps={err.setup} />
        </div>
      );
    }
    throw err;
  }

  return (
    <div className="min-h-screen">
      <div className="max-w-3xl mx-auto px-6 pt-8 pb-12">
        <PageHeader
          breadcrumb={[{ label: "Home", href: "/" }, { label: TITLE }]}
          title={TITLE}
          description={DESCRIPTION}
        />

        {collections.length === 0 ? (
          <div className="text-sm text-stone-500 dark:text-stone-400">
            No collections published yet.
          </div>
        ) : (
          <ul className="divide-y divide-stone-200 dark:divide-stone-800">
            {collections.map((c) => (
              <li key={c.slug} className="py-4">
                <Link
                  href={`/collections/${c.slug}`}
                  className="group flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-stone-900 dark:text-stone-100 group-hover:text-stone-600 dark:group-hover:text-stone-300">
                      {c.name}
                    </div>
                    {c.description && (
                      <div className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
                        {c.description}
                      </div>
                    )}
                    {c.previewMembers && c.previewMembers.length > 0 && (
                      <MemberFacepile members={c.previewMembers} totalCount={c.memberCount} />
                    )}
                  </div>
                  <div className="shrink-0 text-[12px] tabular-nums text-stone-400 dark:text-stone-500">
                    {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
