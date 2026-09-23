import type { CollectionMember } from "@/lib/api";
import { OrgAvatar } from "@/components/org-avatar";
import { memberKey } from "@/lib/member-key";

/**
 * Inline avatar facepile for a list of entity members — overlapping org avatars
 * followed by a comma-separated name list and a "+ N more" tail. Shared by the
 * collections list page, the categories list page, and collection hits in
 * search, so all three surfaces preview their members identically.
 *
 * `members` is the small preview subset (already capped by the API). `totalCount`
 * is the full membership size used to compute the "+ N more" tail — for
 * categories that's `orgCount + productCount`, for collections it's `memberCount`.
 * Product members render their parent org's avatar (products have none of their
 * own); the name list shows the member's own name.
 */
export function MemberFacepile({
  members,
  totalCount,
  className = "mt-2",
}: {
  members: CollectionMember[];
  totalCount: number;
  className?: string;
}) {
  const remaining = totalCount - members.length;
  return (
    <div
      className={`flex items-center gap-1.5 text-[12px] text-stone-500 dark:text-stone-400 ${className}`}
    >
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
