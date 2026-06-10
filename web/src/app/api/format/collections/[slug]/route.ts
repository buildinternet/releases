import { type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { collectionAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { collectionToMarkdown, collectionReleaseFeedToMarkdown } from "@/lib/formatters";
import { jsonFormatResponse } from "@/lib/json-response";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const format = getFormat(request);

  if (format === "atom") {
    let collection, feed;
    try {
      [collection, feed] = await Promise.all([
        api.collectionDetail(slug),
        api.collectionReleases(slug, { limit: ATOM_DEFAULT_MAX_ENTRIES }),
      ]);
    } catch (err) {
      return formatErrorResponse(err, "Collection not found");
    }
    return collectionAtomResponse(request, collection, feed);
  }

  if (format === "md") {
    let collection, feed;
    try {
      [collection, feed] = await Promise.all([
        api.collectionDetail(slug),
        api.collectionReleases(slug, { limit: 20 }),
      ]);
    } catch (err) {
      return formatErrorResponse(err, "Collection not found");
    }
    const baseUrl = getBaseUrl(request);
    const detail = collectionToMarkdown(collection, { baseUrl });
    const releases = collectionReleaseFeedToMarkdown(
      collection.slug,
      collection.name,
      feed.releases,
      feed.pagination,
      { baseUrl },
    );
    return markdownResponse(`${detail}\n## Recent Releases\n\n${releases}`, {
      cache: "dynamic",
      canonical: `${baseUrl}/collections/${slug}`,
    });
  }

  let collection, feed;
  try {
    [collection, feed] = await Promise.all([
      api.collectionDetail(slug),
      api.collectionReleases(slug, { limit: 20 }),
    ]);
  } catch (err) {
    return formatErrorResponse(err, "Collection not found");
  }
  return jsonFormatResponse({
    ...collection,
    releases: feed.releases,
    pagination: feed.pagination,
  });
}
