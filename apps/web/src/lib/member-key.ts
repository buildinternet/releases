import type { CollectionMember } from "@/lib/api";

/**
 * Stable identity for a collection member chip / filter token.
 *
 * Orgs key on `org:<slug>`; products key on `product:<orgSlug>/<slug>` because
 * post-#690 product slugs are per-org — two collections that pin "cli" from
 * different orgs would otherwise share a key. Exported from a server-safe
 * module so server pages and the client timeline derive the same identity.
 */
export function memberKey(m: CollectionMember): string {
  if (m.kind === "org") return `org:${m.slug}`;
  return `product:${m.org.slug}/${m.slug}`;
}
