import { NextRequest, NextResponse } from "next/server";
import { categoryDisplayName, isValidCategory } from "@buildinternet/releases-core/categories";
import { api } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { categoryAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { categoryReleaseFeedToMarkdown } from "@/lib/formatters";
import { jsonFormatResponse } from "@/lib/json-response";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidCategory(slug)) {
    return NextResponse.json(
      { error: "not_found", message: "Category not found" },
      { status: 404 },
    );
  }
  const name = categoryDisplayName(slug);
  const format = getFormat(request);

  if (format === "atom") {
    let feed;
    try {
      feed = await api.categoryReleases(slug, { limit: ATOM_DEFAULT_MAX_ENTRIES });
    } catch (err) {
      return formatErrorResponse(err, "Category not found");
    }
    return categoryAtomResponse(request, { slug, name }, feed);
  }

  if (format === "md") {
    let feed;
    try {
      feed = await api.categoryReleases(slug, { limit: 20 });
    } catch (err) {
      return formatErrorResponse(err, "Category not found");
    }
    const baseUrl = getBaseUrl(request);
    const body = categoryReleaseFeedToMarkdown(slug, name, feed.releases, feed.pagination, {
      baseUrl,
    });
    return markdownResponse(body, {
      cache: "dynamic",
      canonical: `${baseUrl}/categories/${slug}`,
    });
  }

  let detail, feed;
  try {
    [detail, feed] = await Promise.all([
      api.categoryDetail(slug),
      api.categoryReleases(slug, { limit: 20 }),
    ]);
  } catch (err) {
    return formatErrorResponse(err, "Category not found");
  }
  return jsonFormatResponse({
    slug,
    name,
    orgs: detail.orgs,
    products: detail.products,
    releases: feed.releases,
    pagination: feed.pagination,
  });
}
