import { NextRequest, NextResponse } from "next/server";
import { categoryDisplayName, isValidCategory } from "@buildinternet/releases-core/categories";
import { api, ApiNotFoundError } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { categoryAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { categoryReleaseFeedToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

const NOT_FOUND_BODY = { error: "not_found", message: "Category not found" };
const BAD_GATEWAY_BODY = { error: "bad_gateway", message: "Upstream API error" };

function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiNotFoundError) {
    return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
  }
  return NextResponse.json(BAD_GATEWAY_BODY, { status: 502 });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidCategory(slug)) {
    return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
  }
  const name = categoryDisplayName(slug);
  const format = getFormat(request);

  if (format === "atom") {
    let feed;
    try {
      feed = await api.categoryReleases(slug, { limit: ATOM_DEFAULT_MAX_ENTRIES });
    } catch (err) {
      return errorResponse(err);
    }
    return categoryAtomResponse(request, { slug, name }, feed);
  }

  if (format === "md") {
    let feed;
    try {
      feed = await api.categoryReleases(slug, { limit: 20 });
    } catch (err) {
      return errorResponse(err);
    }
    const baseUrl = getBaseUrl(request);
    const body = categoryReleaseFeedToMarkdown(slug, name, feed.releases, feed.pagination, {
      baseUrl,
    });
    return markdownResponse(body, { cache: "dynamic" });
  }

  let detail, feed;
  try {
    [detail, feed] = await Promise.all([
      api.categoryDetail(slug),
      api.categoryReleases(slug, { limit: 20 }),
    ]);
  } catch (err) {
    return errorResponse(err);
  }
  return NextResponse.json({
    slug,
    name,
    orgs: detail.orgs,
    products: detail.products,
    releases: feed.releases,
    pagination: feed.pagination,
  });
}
