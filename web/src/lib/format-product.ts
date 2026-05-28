import { NextResponse, type NextRequest } from "next/server";
import { api, type ProductDetail } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { productAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { productToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";
import type { Format } from "@/lib/request";

/**
 * Renders a product's format adapter (`.json` / `.md` / `.atom`), embedding the
 * product's cross-source release feed (#1207). Takes an already-fetched
 * `product` so callers that resolved it (the bare-slug route via `api.resolve`)
 * don't re-fetch the detail. The markdown preview shows fewer entries than the
 * JSON payload, matching the org + source adapters.
 */
export async function productFormatResponse(
  request: NextRequest,
  orgSlug: string,
  product: ProductDetail,
  format: Format,
): Promise<Response> {
  const limit = format === "atom" ? ATOM_DEFAULT_MAX_ENTRIES : format === "md" ? 10 : 20;
  const feed = await api.orgReleases(orgSlug, { product: product.slug, limit });

  if (format === "atom") {
    return productAtomResponse(request, orgSlug, product, feed);
  }

  if (format === "md") {
    return markdownResponse(
      productToMarkdown(product, orgSlug, {
        baseUrl: getBaseUrl(request),
        recentReleases: feed.releases,
      }),
      { cache: "dynamic" },
    );
  }

  // Default (json): the API's public-read endpoint already gates admin-only
  // fields, so the product detail is safe to serve verbatim — mirrors the org
  // format route. `releases` + `pagination` are attached the same way the
  // source detail carries them inline.
  return NextResponse.json({ ...product, releases: feed.releases, pagination: feed.pagination });
}
