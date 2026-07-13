import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { collectionDigestsAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { collectionDigestIndexToMarkdown } from "@/lib/formatters";
import { jsonFormatResponse } from "@/lib/json-response";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

/**
 * Format adapters for `/collections/:slug/digest` — weekly digests index.
 * Suffix routes: `.md` / `.json` / `.atom` (proxy rewrites here with `?format=`).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const format = getFormat(request);

  let collection, digestsRes;
  try {
    [collection, digestsRes] = await Promise.all([
      api.collectionDetail(slug),
      api.collectionWeeklyDigests(slug, { limit: ATOM_DEFAULT_MAX_ENTRIES }),
    ]);
  } catch (err) {
    return formatErrorResponse(err, "Collection not found");
  }

  if (format === "atom") {
    return collectionDigestsAtomResponse(request, collection, digestsRes.digests);
  }

  const baseUrl = getBaseUrl(request);
  const canonical = `${baseUrl}/collections/${slug}/digest`;

  if (format === "md") {
    return markdownResponse(
      collectionDigestIndexToMarkdown(collection, digestsRes.digests, { baseUrl }),
      { cache: "dynamic", canonical },
    );
  }

  return jsonFormatResponse({
    collection: { slug: collection.slug, name: collection.name },
    digests: digestsRes.digests,
    pagination: digestsRes.pagination,
  });
}
