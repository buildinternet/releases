import type { CollectionMember, DigestCoveredRelease } from "@/lib/api";

export type DigestFacepileOrg = {
  slug: string;
  name: string;
  avatarUrl: string | null;
  githubHandle: string | null;
};

/**
 * Build a first-appearance ordered org list from the releases a digest covers,
 * enriching with collection member avatar metadata when available.
 */
export function orgsFromCoveredReleases(
  releases: readonly DigestCoveredRelease[],
  members: readonly CollectionMember[],
): DigestFacepileOrg[] {
  const metaBySlug = new Map<string, { avatarUrl: string | null; githubHandle: string | null }>();
  for (const m of members) {
    if (m.kind === "org") {
      metaBySlug.set(m.slug, { avatarUrl: m.avatarUrl, githubHandle: m.githubHandle });
    } else if (!metaBySlug.has(m.org.slug)) {
      // Product members: parent org avatar, if we haven't seen the org yet.
      metaBySlug.set(m.org.slug, {
        avatarUrl: m.org.avatarUrl,
        githubHandle: m.org.githubHandle,
      });
    }
  }

  const seen = new Set<string>();
  const out: DigestFacepileOrg[] = [];
  for (const r of releases) {
    if (seen.has(r.org.slug)) continue;
    seen.add(r.org.slug);
    const meta = metaBySlug.get(r.org.slug);
    out.push({
      slug: r.org.slug,
      name: r.org.name,
      avatarUrl: meta?.avatarUrl ?? null,
      githubHandle: meta?.githubHandle ?? null,
    });
  }
  return out;
}
