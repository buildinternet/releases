import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/lib/api";
import { ATOM_DEFAULT_MAX_ENTRIES } from "@/lib/atom";
import { productAtomResponse } from "@/lib/atom-response";
import { getBaseUrl } from "@/lib/base-url";
import { formatErrorResponse } from "@/lib/format-error";
import { productToMarkdown } from "@/lib/formatters";
import { markdownResponse } from "@/lib/markdown-response";
import { getFormat } from "@/lib/request";

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
      return formatErrorResponse(err, "Product not found");
    }
    return productAtomResponse(request, orgSlug, product, feed);
  }

  let product;
  try {
    product = await api.productDetail({ orgSlug, productSlug });
  } catch (err) {
    return formatErrorResponse(err, "Product not found");
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
