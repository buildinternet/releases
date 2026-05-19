import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiSetupError, type CollectionListItem, type CollectionMember } from "@/lib/api";
import { Header } from "@/components/header";
import { OrgAvatar } from "@/components/org-avatar";
import { PageHeader } from "@/components/page-header";
import { SetupMessage } from "@/components/setup-message";
import { memberKey } from "@/lib/member-key";

const TITLE = "Collections";
const DESCRIPTION =
  "Curated playlists of organizations on releases.sh — group changelogs by theme to follow a market or topic in one place.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/collections" },
  openGraph: {
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
                      <MemberPreview members={c.previewMembers} totalCount={c.memberCount} />
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

function MemberPreview({
  members,
  totalCount,
}: {
  members: CollectionMember[];
  totalCount: number;
}) {
  const remaining = totalCount - members.length;
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[12px] text-stone-500 dark:text-stone-400">
      <div className="flex -space-x-1.5">
        {members.map((m) => {
          const avatar =
            m.kind === "org"
              ? { avatarUrl: m.avatarUrl, githubHandle: m.githubHandle, name: m.name }
              : {
                  avatarUrl: m.org.avatarUrl,
                  githubHandle: m.org.githubHandle,
                  name: m.org.name,
                };
          const title = m.kind === "org" ? m.name : `${m.name} · ${m.org.name}`;
          return (
            <span
              key={memberKey(m)}
              title={title}
              className="ring-2 ring-white dark:ring-stone-950 rounded-full"
            >
              <OrgAvatar
                avatarUrl={avatar.avatarUrl}
                githubHandle={avatar.githubHandle}
                name={avatar.name}
                size={20}
              />
            </span>
          );
        })}
      </div>
      <span className="truncate">
        {members.map((m) => m.name).join(", ")}
        {remaining > 0 && ` + ${remaining} more`}
      </span>
    </div>
  );
}
