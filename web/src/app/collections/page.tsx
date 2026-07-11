import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CollectionListItem } from "@/lib/api";
import { MemberFacepile } from "@/components/member-facepile";
import { PageHeader } from "@/components/page-header";
import { SetupMessage } from "@/components/setup-message";
import { getLatestDigest } from "./[slug]/digest/_lib/digest-data";

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

  // Small, curated list (~12 collections) — a per-row latest-digest lookup is
  // cheap and keeps the cross-link subtle (dot + one line, no chip row).
  const latestDigests = await Promise.all(
    collections.map((c) => getLatestDigest(c.slug).catch(() => null)),
  );
  const latestBySlug = new Map(collections.map((c, i) => [c.slug, latestDigests[i]]));

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[1240px] px-6 pt-8 pb-12">
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
          <ul className="grid grid-cols-1 gap-x-10 lg:grid-cols-2">
            {collections.map((c) => (
              <li key={c.slug} className="border-b border-stone-200 py-4 dark:border-stone-800">
                <Link href={`/collections/${c.slug}`} className="group block min-w-0">
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
                </Link>
                {latestBySlug.get(c.slug) && (
                  <Link
                    href={`/collections/${c.slug}/digest/${latestBySlug.get(c.slug)!.weekStart}`}
                    className="mt-1.5 inline-block text-xs text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
                    aria-label={`This week's digest for ${c.name}: ${latestBySlug.get(c.slug)!.title}`}
                  >
                    This week: {latestBySlug.get(c.slug)!.title} →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
