import { builder } from "../builder.js";

const CollectionMemberOrgType = builder.objectType("CollectionMemberOrg", {
  description: "An org as it appears in a collection's member preview.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    domain: t.exposeString("domain", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    githubHandle: t.exposeString("githubHandle", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
  }),
});

const CollectionMemberProductOrgType = builder.objectType("CollectionMemberProductOrg", {
  description:
    "Parent-org context on a product member, so the chip can render the org's avatar. " +
    "Subset of CollectionMemberOrg — no `description`, matching REST's ProductParentOrg.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    domain: t.exposeString("domain", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    githubHandle: t.exposeString("githubHandle", { nullable: true }),
  }),
});

const CollectionMemberProductType = builder.objectType("CollectionMemberProduct", {
  description: "A product as it appears in a collection's member preview.",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    org: t.field({ type: CollectionMemberProductOrgType, resolve: (p) => p.org }),
  }),
});

/** Mixed-kind member entry — discriminate on `__typename` client-side
 *  (`... on CollectionMemberOrg` / `... on CollectionMemberProduct`). */
export const CollectionMemberUnion = builder.unionType("CollectionMember", {
  description: "One entry in a collection's `previewMembers` — either an org or a product.",
  types: [CollectionMemberOrgType, CollectionMemberProductType],
  resolveType: (m) => (m.kind === "org" ? CollectionMemberOrgType : CollectionMemberProductType),
});

export const CollectionType = builder.objectType("Collection", {
  description: "A curated, named group of orgs/products (independent of the `category` taxonomy).",
  fields: (t) => ({
    slug: t.exposeString("slug"),
    name: t.exposeString("name"),
    description: t.exposeString("description", { nullable: true }),
    memberCount: t.exposeInt("memberCount"),
    isFeatured: t.exposeBoolean("isFeatured"),
    previewMembers: t.field({
      type: [CollectionMemberUnion],
      description: "Up to 3 interleaved org/product members, for inline avatar chips.",
      resolve: (c) => c.previewMembers,
    }),
  }),
});
