import { NextResponse, type NextRequest } from "next/server";
import { api, ApiNotFoundError } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { productAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { productToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

const NOT_FOUND_BODY = { error: "not_found", message: "Product not found" };
const BAD_GATEWAY_BODY = { error: "bad_gateway", message: "Upstream API error" };

// Only a genuine 404 from the API maps to not_found; transient/backend
// failures (503 setup, 5xx, network) surface as 502 so they aren't
// misclassified. Mirrors the categories format route.
function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiNotFoundError) {
    return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
  }
  return NextResponse.json(BAD_GATEWAY_BODY, { status: 502 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgSlug: string; productSlug: string }> },
) {
  const { orgSlug, productSlug } = await params;
  const format = getFormat(request);

  if (format === "atom") {
    let product, feed;
    try {
      [product, feed] = await Promise.all([
        api.productDetail({ orgSlug, productSlug }),
        api.orgReleases(orgSlug, { product: productSlug, limit: ATOM_DEFAULT_MAX_ENTRIES }),
      ]);
    } catch (err) {
      return errorResponse(err);
    }
    return productAtomResponse(request, orgSlug, product, feed);
  }

  let product;
  try {
    product = await api.productDetail({ orgSlug, productSlug });
  } catch (err) {
    return errorResponse(err);
  }

  if (format === "md") {
    return markdownResponse(productToMarkdown(product, orgSlug, { baseUrl: getBaseUrl(request) }), {
      cache: "semi-static",
    });
  }

  // Default (json): the API's public-read endpoint already gates admin-only
  // fields, so the product detail is safe to serve verbatim — mirrors the org
  // format route.
  return NextResponse.json(product);
}
