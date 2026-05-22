import Link from "next/link";
import type { CollectionListItem, CollectionMember } from "@/lib/api";
import { OrgAvatar } from "@/components/org-avatar";
import { memberKey } from "@/lib/member-key";

/** How many collections the homepage promo block renders, regardless of how
 * many the API returns featured. Keeps the sidebar block "one or two". */
const MAX_FEATURED = 2;
/** Avatar chips per card before collapsing into a "+N" count. */
const MAX_AVATARS = 4;

/**
 * Small homepage promo block for curated collections. Renders in the xl-only
 * sidebar below the install steps; surfaces up to {@link MAX_FEATURED}
 * featured collections so visitors discover the feature exists. Renders
 * nothing when there are no featured collections.
 */
export function FeaturedCollections({ collections }: { collections: CollectionListItem[] }) {
  const featured = collections.slice(0, MAX_FEATURED);
  if (featured.length === 0) return null;

  return (
    <div className="mt-6 text-left bg-stone-50 dark:bg-stone-900/40 border border-stone-200 dark:border-stone-800 rounded-lg p-5 space-y-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-500">
        Collections
      </div>

      <ul className="space-y-4">
        {featured.map((c) => (
          <li key={c.slug}>
            <Link href={`/collections/${c.slug}`} className="group block">
              <div className="text-[13px] font-semibold text-stone-900 dark:text-stone-100 group-hover:text-stone-600 dark:group-hover:text-stone-300">
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
function MemberChips({ members, totalCount }: { members: CollectionMember[]; totalCount: number }) {
  const shown = members.slice(0, MAX_AVATARS);
  const remaining = totalCount - shown.length;
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-stone-400 dark:text-stone-500">
      <div className="flex -space-x-1.5">
        {shown.map((m) => {
          const avatar =
            m.kind === "org"
              ? { avatarUrl: m.avatarUrl, githubHandle: m.githubHandle, name: m.name }
              : { avatarUrl: m.org.avatarUrl, githubHandle: m.org.githubHandle, name: m.org.name };
          const title = m.kind === "org" ? m.name : `${m.name} · ${m.org.name}`;
          return (
            <span
              key={memberKey(m)}
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
