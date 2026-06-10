import { type NextRequest } from "next/server";
import { api, type ProductDetail } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { productAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { productToMarkdown } from "@/lib/formatters";
import { jsonFormatResponse } from "@/lib/json-response";
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

  let feed;
  try {
    feed = await api.orgReleases(orgSlug, { product: product.slug, limit });
  } catch (err) {
    // The product was already resolved by the caller, so only the feed fetch
    // can fail here — map upstream failures to the shared format-route error
    // (404 for a genuine not-found, else 502) instead of leaking a raw 500.
    return formatErrorResponse(err, "Product not found");
  }

  if (format === "atom") {
    return productAtomResponse(request, orgSlug, product, feed);
  }

  const baseUrl = getBaseUrl(request);

  if (format === "md") {
    return markdownResponse(
      productToMarkdown(product, orgSlug, {
        baseUrl,
        recentReleases: feed.releases,
      }),
      // Canonical is the bare product page (#1190), the same URL the HTML page
      // self-canonicals to — so the legacy `/product/` and bare `.md` both
      // consolidate there.
      { cache: "dynamic", canonical: `${baseUrl}/${orgSlug}/${product.slug}` },
    );
  }

  // Default (json): the API's public-read endpoint already gates admin-only
  // fields, so the product detail is safe to serve verbatim — mirrors the org
  // format route. `releases` + `pagination` are attached the same way the
  // source detail carries them inline.
  return jsonFormatResponse({ ...product, releases: feed.releases, pagination: feed.pagination });
}
