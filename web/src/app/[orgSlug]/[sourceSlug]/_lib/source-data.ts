import { cache } from "react";
import { api } from "@/lib/api";

export const getSource = cache((orgSlug: string, sourceSlug: string) =>
  api.sourceDetail({ orgSlug, sourceSlug }),
);

const BASE = "https://releases.sh";

/**
 * Builds the `BreadcrumbList.itemListElement` array for a source sub-page
 * (e.g. /highlights or /changelog). The org breadcrumb is included only when
 * the source has a resolved org.
 */
export function sourceBreadcrumbItems(
  source: { name: string; org: { slug: string; name: string } | null },
  sourceUrl: string,
  pageName: string,
  pageUrl: string,
): object[] {
  const home = { "@type": "ListItem", position: 1, name: "Home", item: BASE };
  if (source.org) {
    return [
      home,
      {
        "@type": "ListItem",
        position: 2,
        name: source.org.name,
        item: `${BASE}/${source.org.slug}`,
      },
      { "@type": "ListItem", position: 3, name: source.name, item: sourceUrl },
      { "@type": "ListItem", position: 4, name: pageName, item: pageUrl },
    ];
  }
  return [
    home,
    { "@type": "ListItem", position: 2, name: source.name, item: sourceUrl },
    { "@type": "ListItem", position: 3, name: pageName, item: pageUrl },
  ];
}
