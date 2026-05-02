import Link from "next/link";
import type { TaxonomyOrg, TaxonomyProduct } from "@buildinternet/releases-api-types";
import { OrgAvatar } from "./org-avatar";

interface TaxonomyListProps {
  orgs: TaxonomyOrg[];
  products: TaxonomyProduct[];
}

export function TaxonomyList({ orgs, products }: TaxonomyListProps) {
  if (orgs.length === 0 && products.length === 0) {
    return (
      <div className="text-center py-12 text-stone-400 dark:text-stone-500 text-sm mt-6">
        Nothing here yet.
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-10 pb-10">
      {orgs.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
            Organizations
          </h2>
          <div className="space-y-2">
            {orgs.map((org) => (
              <Link
                key={org.slug}
                href={`/${org.slug}`}
                className="flex items-center gap-3 p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
              >
                <OrgAvatar
                  avatarUrl={org.avatarUrl}
                  githubHandle={null}
                  name={org.name}
                  size={28}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-stone-900 dark:text-stone-100">
                    {org.name}
                  </div>
                  {org.domain && (
                    <div className="text-xs text-stone-400 dark:text-stone-500 truncate">
                      {org.domain}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {products.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-3">
            Products
          </h2>
          <div className="space-y-2">
            {products.map((product) => (
              <Link
                key={`${product.orgSlug}/${product.slug}`}
                href={`/${product.orgSlug}/product/${product.slug}`}
                className="block p-3 rounded-lg border border-stone-200 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-900 transition-colors"
              >
                <div className="text-sm font-medium text-stone-900 dark:text-stone-100">
                  {product.name}
                  <span className="ml-2 text-xs font-normal text-stone-400 dark:text-stone-500">
                    {product.orgName}
                  </span>
                </div>
                {product.description && (
                  <div className="text-xs text-stone-500 dark:text-stone-400 mt-0.5 line-clamp-1">
                    {product.description}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
