import Link from "next/link";
import { OrgAvatar } from "@/components/org-avatar";

/**
 * Homepage-only collection member shapes, matching the `HomepageCollections`
 * GraphQL operation's selection
 * (`web/src/lib/graphql/operations/homepage-collections.graphql`). GraphQL
 * unions discriminate on `__typename` rather than the REST wire's `kind`
 * field — kept local to this component (rather than folded into the shared
 * `@/lib/member-key`, which other non-homepage components still consume
 * against the REST `CollectionMember` shape).
 */
export interface HomeCollectionMemberOrg {
  __typename: "CollectionMemberOrg";
  slug: string;
  name: string;
  avatarUrl: string | null;
  githubHandle: string | null;
}

export interface HomeCollectionMemberProduct {
  __typename: "CollectionMemberProduct";
  slug: string;
  name: string;
  org: {
    slug: string;
    name: string;
    avatarUrl: string | null;
    githubHandle: string | null;
  };
}

export type HomeCollectionMember = HomeCollectionMemberOrg | HomeCollectionMemberProduct;

export interface HomeCollectionListItem {
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  isFeatured: boolean;
  previewMembers: HomeCollectionMember[];
}

/** Mirrors `@/lib/member-key`'s `memberKey`, discriminating on `__typename`. */
function homeMemberKey(m: HomeCollectionMember): string {
  if (m.__typename === "CollectionMemberOrg") return `org:${m.slug}`;
  return `product:${m.org.slug}/${m.slug}`;
}

/** How many collections the homepage promo block renders, regardless of how
 * many the API returns featured. Keeps the block "one or two". */
const MAX_FEATURED = 2;
/** Avatar chips per card before collapsing into a "+N" count. Matches the
 * API's `previewMembers` cap (PREVIEW_LIMIT = 3) so the slice is a real guard,
 * not a no-op, if that cap ever grows. */
const MAX_AVATARS = 3;

/**
 * Homepage promo for curated collections, in two breakpoint-specific shells
 * over a shared list:
 * - {@link FeaturedCollections}: an expanded card for the xl-only sidebar.
 * - {@link FeaturedCollectionsCollapsible}: an inline disclosure, collapsed by
 *   default, for sub-xl widths where the sidebar is hidden.
 *
 * Both render nothing when there are no featured collections.
 */
export function FeaturedCollections({ collections }: { collections: HomeCollectionListItem[] }) {
  const featured = collections.slice(0, MAX_FEATURED);
  if (featured.length === 0) return null;

  return (
    <div className="mt-6 text-left bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-800 rounded-lg p-5 space-y-4">
      <SectionLabel />
      <FeaturedList collections={featured} />
    </div>
  );
}

export function FeaturedCollectionsCollapsible({
  collections,
}: {
  collections: HomeCollectionListItem[];
}) {
  const featured = collections.slice(0, MAX_FEATURED);
  if (featured.length === 0) return null;

  return (
    <details className="group mb-6 rounded-lg border border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/40 xl:hidden">
      <summary className="flex items-center justify-between px-5 py-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <SectionLabel />
        <svg
          className="w-4 h-4 text-stone-500 transition-transform group-open:rotate-180"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </summary>
      <div className="px-5 pb-5 pt-1">
        <FeaturedList collections={featured} />
      </div>
    </details>
  );
}

function SectionLabel() {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-500">
      Collections
    </div>
  );
}

/** The featured collection cards plus a "browse all" link — shared by both shells. */
function FeaturedList({ collections }: { collections: HomeCollectionListItem[] }) {
  return (
    <div className="space-y-4">
      <ul className="space-y-4">
        {collections.map((c) => (
          <li key={c.slug}>
            <Link href={`/collections/${c.slug}`} className="group/card block">
              <div className="text-[13px] font-semibold text-stone-900 dark:text-stone-100 group-hover/card:text-stone-600 dark:group-hover/card:text-stone-300">
                {c.name}
              </div>
              {c.description && (
                <p className="mt-0.5 text-[12px] leading-snug text-stone-500 dark:text-stone-400 line-clamp-2">
                  {c.description}
                </p>
              )}
              {c.previewMembers && c.previewMembers.length > 0 && (
                <MemberChips members={c.previewMembers} totalCount={c.memberCount} />
              )}
            </Link>
          </li>
        ))}
      </ul>

      <Link
        href="/collections"
        className="inline-block text-[12px] text-stone-700 dark:text-stone-300 underline decoration-stone-300 dark:decoration-stone-700 underline-offset-2 hover:decoration-stone-500 dark:hover:decoration-stone-400 transition-colors"
      >
        Browse all collections →
      </Link>
    </div>
  );
}

/** Compact avatar stack + count for one collection's preview members. */
function MemberChips({
  members,
  totalCount,
}: {
  members: HomeCollectionMember[];
  totalCount: number;
}) {
  const shown = members.slice(0, MAX_AVATARS);
  const remaining = totalCount - shown.length;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500">
      <div className="flex -space-x-1.5">
        {shown.map((m) => {
          const avatar =
            m.__typename === "CollectionMemberOrg"
              ? { avatarUrl: m.avatarUrl, githubHandle: m.githubHandle, name: m.name }
              : { avatarUrl: m.org.avatarUrl, githubHandle: m.org.githubHandle, name: m.org.name };
          const title =
            m.__typename === "CollectionMemberOrg" ? m.name : `${m.name} · ${m.org.name}`;
          return (
            <span
              key={homeMemberKey(m)}
              title={title}
              className="ring-2 ring-stone-50 dark:ring-stone-900 rounded-full"
            >
              <OrgAvatar
                avatarUrl={avatar.avatarUrl}
                githubHandle={avatar.githubHandle}
                name={avatar.name}
                size={18}
              />
            </span>
          );
        })}
      </div>
      {remaining > 0 && <span className="tabular-nums">+{remaining}</span>}
    </div>
  );
}
