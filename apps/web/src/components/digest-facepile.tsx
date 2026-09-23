import Link from "next/link";
import { OrgAvatar } from "@/components/org-avatar";
import { orgsFromCoveredReleases, type DigestFacepileOrg } from "@/components/digest-facepile-orgs";

export { orgsFromCoveredReleases, type DigestFacepileOrg };

const MAX_AVATARS = 8;

/**
 * Avatar stack of orgs covered by a weekly digest — same ring/overlap cue as
 * the collection day facepile and MemberFacepile, linked to each org page.
 */
export function DigestFacepile({
  orgs,
  className = "",
}: {
  orgs: DigestFacepileOrg[];
  className?: string;
}) {
  if (orgs.length === 0) return null;
  const shown = orgs.slice(0, MAX_AVATARS);
  const extra = orgs.length - shown.length;

  return (
    <div
      className={`flex items-center gap-2 text-[12px] text-[var(--fg-3)] ${className}`}
      aria-label={`Covered companies: ${orgs.map((o) => o.name).join(", ")}`}
    >
      <div className="flex -space-x-1.5">
        {shown.map((o) => (
          <Link
            key={o.slug}
            href={`/${o.slug}`}
            title={o.name}
            className="rounded-full ring-2 ring-[var(--page)] transition-opacity hover:opacity-90"
          >
            <OrgAvatar
              avatarUrl={o.avatarUrl}
              githubHandle={o.githubHandle}
              name={o.name}
              size={22}
            />
          </Link>
        ))}
      </div>
      {extra > 0 && (
        <span className="font-mono text-[11px] tabular-nums text-[var(--fg-3)]">+{extra}</span>
      )}
      <span className="min-w-0 truncate">
        {shown.map((o) => o.name).join(", ")}
        {extra > 0 ? ` + ${extra} more` : ""}
      </span>
    </div>
  );
}
