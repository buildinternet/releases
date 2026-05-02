import { eq } from "drizzle-orm";
import { organizations, products } from "@buildinternet/releases-core/schema";

// Loose type so this composes with both the schema-aware `createDb()` handle
// used in routes and the generic `drizzle(env.DB)` handle used in cron.
type DrizzleLike = {
  select: (fields: { slug: typeof organizations.slug | typeof products.slug }) => {
    from: (table: unknown) => {
      where: (cond: unknown) => { limit: (n: number) => Promise<Array<{ slug: string }>> };
    };
  };
};

export async function resolveOrgSlug(db: unknown, orgId: string): Promise<string | null> {
  const [row] = await (db as DrizzleLike)
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.slug ?? null;
}

export async function resolveProductSlug(db: unknown, productId: string): Promise<string | null> {
  const [row] = await (db as DrizzleLike)
    .select({ slug: products.slug })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row?.slug ?? null;
}
